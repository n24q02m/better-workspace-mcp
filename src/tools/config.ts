/**
 * Config Tool
 * Manage credential state, the configuration lifecycle, and the set of Google
 * accounts the server can act as. Does NOT require a configured Google account
 * -- works independently of the domain tools.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getAuth, getState, resetState, resolveCredentialState } from '../auth/credential-state.js'
import { WorkspaceMCPError, withErrorHandling } from './helpers/errors.js'

export interface ConfigInput {
  action:
    | 'status'
    | 'setup_start'
    | 'setup_reset'
    | 'setup_complete'
    | 'set'
    | 'cache_clear'
    | 'account_add'
    | 'account_list'
    | 'account_remove'
    | 'account_set_default'
  key?: string
  value?: string
  account?: string
}

// The MCP SDK's own CallTool result type -- reusing it (rather than a
// hand-rolled lookalike) keeps `config()` structurally exact for setRequestHandler.
export type ConfigResult = CallToolResult

const VALID_ACTIONS =
  'status, setup_start, setup_reset, setup_complete, set, cache_clear, account_add, account_list, account_remove, account_set_default'

async function statusJson(): Promise<string> {
  const state = getState()
  const { accounts, primary } = await getAuth().listAccounts()
  return JSON.stringify({ state, configured: state === 'configured', accounts, primary })
}

function textResult(text: string): ConfigResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * account_remove / account_set_default act on ONE named account. There is no
 * safe default to fall back on -- defaulting to the primary would silently
 * remove or reshuffle the wrong account.
 */
function requireAccount(input: ConfigInput): string {
  if (!input.account) {
    throw new WorkspaceMCPError(
      `${input.action} requires an account`,
      'VALIDATION_ERROR',
      'Pass account="<email>" (see config action="account_list")'
    )
  }
  return input.account
}

/**
 * Manage server configuration and credential state
 */
export function config(input: ConfigInput): Promise<ConfigResult> {
  return withErrorHandling(async () => {
    switch (input.action) {
      case 'status':
        return textResult(await statusJson())

      case 'setup_start':
        return textResult(
          'Restart the server to trigger the browser Google OAuth consent flow. Once you complete the consent screen, retry the tool.'
        )

      case 'setup_reset':
        await resetState()
        return textResult(await statusJson())

      case 'setup_complete':
        await resolveCredentialState()
        return textResult(await statusJson())

      case 'set':
        return textResult(
          'No mutable runtime settings in M1. To update credentials, use setup_reset then restart the server.'
        )

      case 'cache_clear':
        return textResult('No client-side cache to clear in M1.')

      case 'account_list': {
        const { accounts, primary } = await getAuth().listAccounts()
        return textResult(JSON.stringify({ accounts, primary }))
      }

      case 'account_remove': {
        const email = requireAccount(input)
        const { removed, newPrimary } = await getAuth().removeAccount(email)
        // Removing the last account puts the server back in awaiting_setup, so the
        // credential gate stops letting domain calls through.
        await resolveCredentialState()
        return textResult(JSON.stringify({ removed, primary: newPrimary }))
      }

      case 'account_set_default': {
        const email = requireAccount(input)
        await getAuth().setPrimary(email)
        return textResult(JSON.stringify({ primary: email.trim().toLowerCase() }))
      }

      case 'account_add':
        return textResult(
          'Restart the server (or run the CLI) to add another Google account through the browser consent flow.'
        )

      default:
        throw new WorkspaceMCPError(
          `Unsupported action: ${(input as { action: string }).action}`,
          'VALIDATION_ERROR',
          `Valid actions: ${VALID_ACTIONS}`
        )
    }
  })()
}
