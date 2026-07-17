/**
 * Tool Registry -- N+2 tool surface: 1 mega-tool per domain (docs; Task 7
 * appends 9 more) + 2 infra tools (config, help). TOOLS, RESOURCES, the help
 * topic allowlist, and the CallTool dispatch map are all derived from the
 * single DOMAINS list in ./domains/index.js -- see that file to add a domain.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { getState } from '../auth/credential-state.js'
import { config } from './config.js'
import { DOMAINS, type DomainDef } from './domains/index.js'
import { aiReadableMessage, findClosestMatch, WorkspaceMCPError } from './helpers/errors.js'

// Tools that work without a configured Google account
// 'time' is a no-auth domain (local date/time helpers) — exempt from the credential gate.
const TOKEN_FREE_TOOLS = new Set(['config', 'help', 'time'])

// Get docs directory path - works for both bundled CLI and unbundled code
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// For bundled CLI: __dirname = /bin/, docs at /build/src/docs/
// For unbundled: __dirname = /build/src/tools/, docs at /build/src/docs/
const DOCS_DIR = __dirname.endsWith('bin')
  ? join(__dirname, '..', 'build', 'src', 'docs')
  : join(__dirname, '..', 'docs')

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Documentation resources for full tool details. One per domain, plus the
 * config and help infra tools' own docs (not domains themselves).
 */
const RESOURCES = [
  ...DOMAINS.map((d) => ({
    uri: `workspace://docs/${d.name}`,
    name: `${capitalize(d.name)} Tool Docs`,
    file: `${d.name}.md`
  })),
  { uri: 'workspace://docs/config', name: 'Config Tool Docs', file: 'config.md' },
  { uri: 'workspace://docs/overview', name: 'Overview Docs', file: 'overview.md' }
]

const PRECOMPUTED_RESOURCES = RESOURCES.map((r) => ({ uri: r.uri, name: r.name, mimeType: 'text/markdown' }))
const RESOURCE_MAP = new Map(RESOURCES.map((r) => [r.uri, r]))
const AVAILABLE_RESOURCE_URIS = RESOURCES.map((r) => r.uri).join(', ')

const HELP_TOPICS = [...DOMAINS.map((d) => d.name), 'config', 'overview']
const VALID_HELP_TOPICS = new Set<string>(HELP_TOPICS)
const VALID_HELP_TOPICS_STRING = HELP_TOPICS.join(', ')

/**
 * A domain's mega-tool definition, derived from its DomainDef -- action enum
 * comes from `actions`, extra params from `inputProps`, and `account` is
 * appended for every domain (accepted, ignored in M1 single-account mode).
 */
function domainToolDef(domain: DomainDef) {
  return {
    name: domain.name,
    description: domain.description,
    annotations: {
      title: capitalize(domain.name),
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...domain.actions], description: 'Action to perform' },
        account: { type: 'string', description: 'Account identifier (accepted, ignored in M1 single-account mode)' },
        ...domain.inputProps
      },
      required: ['action']
    }
  }
}

/**
 * N=1 domain now (docs). Task 7 appends 9 more entries to DOMAINS, not here.
 */
const TOOLS = [
  ...DOMAINS.map(domainToolDef),
  {
    name: 'config',
    description:
      'Manage server configuration and credential state.\n\nActions:\n- status: current credential state\n- setup_start: instructions to configure the Google account via browser OAuth\n- setup_reset: clear credentials, return to awaiting_setup\n- setup_complete: re-check credentials after external config changes\n- set: update a runtime setting (M1 has no mutable settings; returns info)\n- cache_clear: clear any cached state (no-op in M1)',
    annotations: {
      title: 'Config',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'setup_start', 'setup_reset', 'setup_complete', 'set', 'cache_clear'],
          description: 'Action to perform'
        },
        key: { type: 'string', description: 'Setting key (for set action)' },
        value: { type: 'string', description: 'Setting value (for set action)' }
      },
      required: ['action']
    }
  },
  {
    name: 'help',
    description: 'Get full documentation for a topic. Use when compressed tool descriptions are insufficient.',
    annotations: {
      title: 'Help',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: [...HELP_TOPICS], description: 'Topic to get documentation for' }
      },
      required: ['topic']
    }
  }
]

const ALL_TOOL_NAMES = TOOLS.map((t) => t.name)
const ALL_TOOL_NAMES_STRING = ALL_TOOL_NAMES.join(', ')

/**
 * Dispatch map for domain mega-tools, keyed by domain name. Each entry
 * returns the MCP CallTool result shape directly (no re-wrapping). Task 7
 * appends 9 more entries to DOMAINS, not here.
 */
const DOMAIN_MAP = new Map(DOMAINS.map((d) => [d.name, d.run]))

/**
 * Register all tools with the MCP server. Single-account M1 -- no client factory.
 */
export function registerTools(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
  }))

  // Resources handlers for full documentation
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: PRECOMPUTED_RESOURCES
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    const resource = RESOURCE_MAP.get(uri)

    if (!resource) {
      throw new WorkspaceMCPError(
        `Resource not found: ${uri}`,
        'RESOURCE_NOT_FOUND',
        `Available: ${AVAILABLE_RESOURCE_URIS}`
      )
    }

    const fullPath = join(DOCS_DIR, basename(resource.file))
    const rel = relative(DOCS_DIR, fullPath)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceMCPError('Path traversal attempt detected', 'SECURITY_ERROR', 'Invalid resource URI')
    }

    try {
      const content = await readFile(fullPath, 'utf-8')
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: content }]
      }
    } catch {
      throw new WorkspaceMCPError(
        `Documentation not found for: ${resource.name}`,
        'DOC_NOT_FOUND',
        'Check resource URI'
      )
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (!args) {
      return {
        content: [{ type: 'text', text: 'Error: No arguments provided' }],
        isError: true
      }
    }

    // Credential guard. config and help work without a configured Google
    // account; every domain tool (docs, and the 9 more Task 7 appends)
    // requires the OAuth flow to have completed at least once.
    if (!TOKEN_FREE_TOOLS.has(name) && getState() !== 'configured') {
      return {
        content: [
          {
            type: 'text',
            text: 'Google account not configured. Restart the server to complete the browser OAuth consent flow, or call config(action="setup_start") for instructions.'
          }
        ],
        isError: true
      }
    }

    try {
      const domainRun = DOMAIN_MAP.get(name)
      if (domainRun) {
        return await domainRun(args as any)
      }

      switch (name) {
        case 'config':
          return await config(args as any)

        case 'help': {
          const topic = (args as { topic: string }).topic
          // Security: validate topic against allowlist to prevent path traversal
          if (!VALID_HELP_TOPICS.has(topic)) {
            throw new WorkspaceMCPError(
              `Invalid topic: ${topic}`,
              'VALIDATION_ERROR',
              `Valid topics: ${VALID_HELP_TOPICS_STRING}`
            )
          }
          // Security: basename() ensures we only look for files directly inside
          // DOCS_DIR, even if the allowlist check above were bypassed.
          const docFile = `${basename(topic)}.md`
          const fullPath = join(DOCS_DIR, docFile)
          const rel = relative(DOCS_DIR, fullPath)
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new WorkspaceMCPError('Path traversal attempt detected', 'SECURITY_ERROR', 'Invalid topic')
          }

          try {
            const content = await readFile(fullPath, 'utf-8')
            return { content: [{ type: 'text', text: content }] }
          } catch {
            throw new WorkspaceMCPError(`Documentation not found for: ${topic}`, 'DOC_NOT_FOUND', 'Check topic')
          }
        }

        default: {
          const closest = findClosestMatch(name, ALL_TOOL_NAMES)
          const suggestion = closest ? ` Did you mean '${closest}'?` : ''
          throw new WorkspaceMCPError(
            `Unknown tool: ${name}.${suggestion}`,
            'UNKNOWN_TOOL',
            `Available tools: ${ALL_TOOL_NAMES_STRING}`
          )
        }
      }
    } catch (error) {
      const enhancedError =
        error instanceof WorkspaceMCPError
          ? error
          : new WorkspaceMCPError((error as Error).message, 'TOOL_ERROR', 'Check the error details and try again')

      return {
        content: [{ type: 'text', text: aiReadableMessage(enhancedError) }],
        isError: true
      }
    }
  })
}
