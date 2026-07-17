/**
 * Unified entry point for Better Workspace MCP
 *
 * TRANSPORT_MODE selects the transport:
 *   - "stdio" (default): Local mode. One-shot Google OAuth setup on first run
 *     (mcp-core delegated redirect flow, offline access -> refresh_token),
 *     then MCP SDK StdioServerTransport directly (no daemon proxy hop).
 *   - "http": Milestone 3 (not yet implemented).
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getState, resolveCredentialState } from './auth/credential-state.js'
import { runOAuthSetup } from './auth/oauth-setup.js'
import { SERVER_NAME } from './constants.js'
import { registerTools } from './tools/registry.js'

function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Checks if the current module is the main entry point.
 */
export function isMain(importMetaUrl: string): boolean {
  const entrypoint = process.argv[1]
  if (!entrypoint) return false

  try {
    const mainPath = realpathSync(fileURLToPath(importMetaUrl))
    const entryPath = realpathSync(entrypoint)

    if (process.platform === 'win32') {
      // Normalize slashes and casing for Windows
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
      return normalize(mainPath) === normalize(entryPath)
    }

    return mainPath === entryPath
  } catch {
    return false
  }
}

/**
 * Validates and returns the transport mode from the environment.
 */
export function getTransportMode(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string {
  const isHttp = argv.includes('--http') || env.MCP_TRANSPORT === 'http' || env.TRANSPORT_MODE === 'http'
  return isHttp ? 'http' : 'stdio'
}

/**
 * Dynamically imports and starts the server for the specified mode.
 */
export async function startServer(mode: string): Promise<void> {
  if (process.env.BETTER_WORKSPACE_MCP_BOOTSTRAPPED) {
    console.error('[better-workspace-mcp] Startup aborted: server already running in this process tree.')
    return
  }
  process.env.BETTER_WORKSPACE_MCP_BOOTSTRAPPED = 'true'

  if (mode === 'http') {
    throw new Error('http mode is Milestone 3 (not yet implemented)')
  }

  // Stdio mode: no static token env var (unlike notion's NOTION_TOKEN) --
  // Google delegated OAuth persists tokens to disk via credential-state, so
  // only the FIRST run needs the browser step; later starts resolve straight
  // to 'configured'.
  await resolveCredentialState()
  if (getState() !== 'configured') {
    await runOAuthSetup() // opens browser, persists Google tokens
    await resolveCredentialState() // -> 'configured'
  }

  const server = new Server(
    { name: SERVER_NAME, version: getPackageVersion() },
    { capabilities: { tools: {}, resources: {} } }
  )
  registerTools(server) // NO client factory (single-account M1)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[${SERVER_NAME}] stdio mode ready (v${getPackageVersion()})`)
}

// Global state for the selected mode
export const mode = getTransportMode()

/**
 * Bootstrap function to start the server with error handling.
 */
export async function bootstrap(selectedMode: string = mode) {
  try {
    await startServer(selectedMode)
  } catch (error) {
    console.error('Failed to start server:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Only execute bootstrap if we're the main module and not in a test environment.
if (isMain(import.meta.url) && process.env.NODE_ENV !== 'test') {
  bootstrap()
}
