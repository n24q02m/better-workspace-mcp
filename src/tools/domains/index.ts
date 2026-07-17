/**
 * Single source of truth for N+2 domain tools. Each DomainDef fully
 * describes one domain (docs; Task 7b appends 9 more) -- registry.ts derives
 * TOOLS, RESOURCES, the help topic allowlist, and the CallTool dispatch map
 * from this one list instead of maintaining them as separate hand-synced
 * arrays. Adding a domain = pushing one DomainDef here.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DOCS_ACTIONS, docs } from './docs.js'
import type { DomainRunInput } from './factory.js'

export interface DomainDef {
  name: string // tool name, e.g. 'docs'
  description: string // tool description (actions summary)
  actions: readonly string[] // = the vendored service method names
  inputProps: Record<string, unknown> // JSON-schema properties beyond action+account
  run: (input: DomainRunInput) => Promise<CallToolResult>
}

export const DOMAINS: DomainDef[] = [
  {
    name: 'docs',
    description:
      'Google Docs operations.\n\nActions (required params -> optional):\n- getText (documentId -> tabId)\n- create (title -> content)\n- writeText (documentId, text -> position, tabId)\n- getSuggestions (documentId)\n- replaceText (documentId, findText, replaceText -> tabId)\n- formatText (documentId, formats -> tabId)\n\naccount is accepted but IGNORED in M1 (single-account; M2 wires per-account auth).',
    actions: DOCS_ACTIONS,
    inputProps: {
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
    run: docs
  }
]
