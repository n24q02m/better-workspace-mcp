/**
 * Config Tool
 * Manage credential state and configuration lifecycle. Does NOT require a
 * configured Google account -- works independently of the domain tools.
 * Single-account M1 (no account_* actions -- those ship in M2).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getState, resetState, resolveCredentialState } from '../auth/credential-state.js'
import { WorkspaceMCPError, withErrorHandling } from './helpers/errors.js'

export interface ConfigInput {
  action: 'status' | 'setup_start' | 'setup_reset' | 'setup_complete' | 'set' | 'cache_clear'
  key?: string
  value?: string
}

// The MCP SDK's own CallTool result type -- reusing it (rather than a
// hand-rolled lookalike) keeps `config()` structurally exact for setRequestHandler.
export type ConfigResult = CallToolResult

function statusJson(): string {
  const state = getState()
  return JSON.stringify({ state, configured: state === 'configured' })
}

function textResult(text: string): ConfigResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * Manage server configuration and credential state
 */
export function config(input: ConfigInput): Promise<ConfigResult> {
  return withErrorHandling(async () => {
    switch (input.action) {
      case 'status':
        return textResult(statusJson())

      case 'setup_start':
        return textResult(
          'Restart the server to trigger the browser Google OAuth consent flow. Once you complete the consent screen, retry the tool.'
        )

      case 'setup_reset':
        await resetState()
        return textResult(statusJson())

      case 'setup_complete':
        await resolveCredentialState()
        return textResult(statusJson())

      case 'set':
        return textResult(
          'No mutable runtime settings in M1. To update credentials, use setup_reset then restart the server.'
        )

      case 'cache_clear':
        return textResult('No client-side cache to clear in M1.')

      default:
        throw new WorkspaceMCPError(
          `Unsupported action: ${(input as { action: string }).action}`,
          'VALIDATION_ERROR',
          'Valid actions: status, setup_start, setup_reset, setup_complete, set, cache_clear'
        )
    }
  })()
}
