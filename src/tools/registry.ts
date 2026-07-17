/**
 * Tool Registry -- N+2 tool surface: 1 mega-tool per domain (docs; Task 7
 * appends 9 more) + 2 infra tools (config, help).
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
import { DOCS_ACTIONS, type DocsResult, docs } from './domains/docs.js'
import { aiReadableMessage, findClosestMatch, WorkspaceMCPError } from './helpers/errors.js'

// Tools that work without a configured Google account
const TOKEN_FREE_TOOLS = new Set(['config', 'help'])

// Get docs directory path - works for both bundled CLI and unbundled code
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// For bundled CLI: __dirname = /bin/, docs at /build/src/docs/
// For unbundled: __dirname = /build/src/tools/, docs at /build/src/docs/
const DOCS_DIR = __dirname.endsWith('bin')
  ? join(__dirname, '..', 'build', 'src', 'docs')
  : join(__dirname, '..', 'docs')

/**
 * Documentation resources for full tool details
 */
const RESOURCES = [
  { uri: 'workspace://docs/docs', name: 'Docs Tool Docs', file: 'docs.md' },
  { uri: 'workspace://docs/config', name: 'Config Tool Docs', file: 'config.md' },
  { uri: 'workspace://docs/overview', name: 'Overview Docs', file: 'overview.md' }
]

const PRECOMPUTED_RESOURCES = RESOURCES.map((r) => ({ uri: r.uri, name: r.name, mimeType: 'text/markdown' }))
const RESOURCE_MAP = new Map(RESOURCES.map((r) => [r.uri, r]))
const AVAILABLE_RESOURCE_URIS = RESOURCES.map((r) => r.uri).join(', ')

const HELP_TOPICS = ['docs', 'config', 'overview'] as const
const VALID_HELP_TOPICS = new Set<string>(HELP_TOPICS)
const VALID_HELP_TOPICS_STRING = HELP_TOPICS.join(', ')

/**
 * N=1 domain now (docs). Task 7 appends 9 more domain tool definitions here.
 */
const TOOLS = [
  {
    name: 'docs',
    description:
      'Google Docs operations.\n\nActions (required params -> optional):\n- getText (documentId -> tabId)\n- create (title -> content)\n- writeText (documentId, text -> position, tabId)\n- getSuggestions (documentId)\n- replaceText (documentId, findText, replaceText -> tabId)\n- formatText (documentId, formats -> tabId)\n\naccount is accepted but IGNORED in M1 (single-account; M2 wires per-account auth).',
    annotations: {
      title: 'Docs',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...DOCS_ACTIONS], description: 'Action to perform' },
        account: { type: 'string', description: 'Account identifier (accepted, ignored in M1 single-account mode)' },
        documentId: { type: 'string', description: 'Google Doc ID or URL' },
        title: { type: 'string', description: 'Document title (for create)' },
        content: { type: 'string', description: 'Initial document content (for create)' },
        text: { type: 'string', description: 'Text to insert (for writeText)' },
        position: {
          type: 'string',
          description: 'Insert position for writeText: "beginning", "end" (default), or a positive integer index'
        },
        tabId: { type: 'string', description: 'Tab ID to target (optional, for multi-tab documents)' },
        findText: { type: 'string', description: 'Text to find (for replaceText)' },
        replaceText: { type: 'string', description: 'Replacement text (for replaceText)' },
        formats: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startIndex: { type: 'number' },
              endIndex: { type: 'number' },
              style: { type: 'string' },
              url: { type: 'string' }
            },
            required: ['startIndex', 'endIndex', 'style']
          },
          description: 'Formatting operations to apply (for formatText)'
        }
      },
      required: ['action']
    }
  },
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
 * Dispatch map for domain mega-tools. Each entry returns the MCP CallTool
 * result shape directly (no re-wrapping). Task 7 appends 9 more entries here.
 */
const DOMAIN_HANDLERS: Record<string, (args: any) => Promise<DocsResult>> = {
  docs
}

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
      const domainHandler = DOMAIN_HANDLERS[name]
      if (domainHandler) {
        return await domainHandler(args)
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
