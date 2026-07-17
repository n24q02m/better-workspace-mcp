/**
 * Docs Mega Tool
 * All Google Docs operations in one unified interface, dispatched by `action`
 * to the vendored DocsService.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { BASE_SCOPES } from '../../constants.js'
import { AuthManager } from '../../vendored/auth/AuthManager.js'
import { DocsService } from '../../vendored/services/DocsService.js'
import { WorkspaceMCPError, withErrorHandling } from '../helpers/errors.js'

// Action name = DocsService method name (verbatim).
export const DOCS_ACTIONS = ['getText', 'create', 'writeText', 'getSuggestions', 'replaceText', 'formatText'] as const

const svc = new DocsService(new AuthManager(BASE_SCOPES))

export interface DocsInput {
  action: string
  account?: string
  [key: string]: unknown
}

// The MCP SDK's own CallTool result type -- DocsService methods already
// produce values shaped like this, so reusing it (rather than a hand-rolled
// lookalike) keeps `docs()` structurally exact for setRequestHandler.
export type DocsResult = CallToolResult

type DocsMethod = (params: unknown) => Promise<DocsResult>

/**
 * Dispatch a docs action to the matching DocsService method. DocsService
 * methods already return the MCP CallTool result shape
 * ({content: [...], isError?}), so the result is returned directly -- no
 * re-wrapping.
 */
export function docs(input: DocsInput): Promise<DocsResult> {
  return withErrorHandling(async () => {
    const { action, account, ...params } = input
    if (!(DOCS_ACTIONS as readonly string[]).includes(action)) {
      throw new WorkspaceMCPError(
        `Unknown action: ${action}`,
        'VALIDATION_ERROR',
        `Valid actions: ${DOCS_ACTIONS.join(', ')}`
      )
    }
    // account is accepted but ignored in M1 (single-account; M2 wires per-account auth).
    void account
    const method = (svc as unknown as Record<string, DocsMethod>)[action]
    return method(params)
  })()
}
