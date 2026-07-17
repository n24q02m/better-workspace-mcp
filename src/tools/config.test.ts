import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth/credential-state.js', () => ({
  getState: vi.fn(() => 'awaiting_setup'),
  resetState: vi.fn(),
  resolveCredentialState: vi.fn()
}))

import { getState, resetState, resolveCredentialState } from '../auth/credential-state.js'
import { config } from './config.js'

function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return 'text' in first ? first.text : ''
}

describe('config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getState).mockReturnValue('awaiting_setup')
  })

  describe('status action', () => {
    it('reports awaiting_setup state', async () => {
      const result = await config({ action: 'status' })

      expect(JSON.parse(textOf(result))).toEqual({ state: 'awaiting_setup', configured: false })
    })

    it('reports configured state', async () => {
      vi.mocked(getState).mockReturnValue('configured')

      const result = await config({ action: 'status' })

      expect(JSON.parse(textOf(result))).toEqual({ state: 'configured', configured: true })
    })
  })

  describe('setup_start action', () => {
    it('returns browser OAuth restart instructions', async () => {
      const result = await config({ action: 'setup_start' })

      expect(textOf(result)).toContain('OAuth')
      expect(textOf(result)).toContain('Restart the server')
    })
  })

  describe('setup_reset action', () => {
    it('resets credential state and reports the new status', async () => {
      const result = await config({ action: 'setup_reset' })

      expect(resetState).toHaveBeenCalledTimes(1)
      expect(JSON.parse(textOf(result))).toEqual({ state: 'awaiting_setup', configured: false })
    })
  })

  describe('setup_complete action', () => {
    it('re-resolves credential state and reports it', async () => {
      vi.mocked(getState).mockReturnValue('configured')

      const result = await config({ action: 'setup_complete' })

      expect(resolveCredentialState).toHaveBeenCalledTimes(1)
      expect(JSON.parse(textOf(result))).toEqual({ state: 'configured', configured: true })
    })
  })

  describe('set action', () => {
    it('returns a no-op info message', async () => {
      const result = await config({ action: 'set' })

      expect(textOf(result)).toContain('No mutable runtime settings')
    })
  })

  describe('cache_clear action', () => {
    it('returns a no-op info message', async () => {
      const result = await config({ action: 'cache_clear' })

      expect(textOf(result)).toContain('No client-side cache')
    })
  })

  describe('invalid action', () => {
    it('throws a WorkspaceMCPError listing valid actions', async () => {
      await expect(config({ action: 'bogus' as never })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Unsupported action: bogus',
        suggestion: 'Valid actions: status, setup_start, setup_reset, setup_complete, set, cache_clear'
      })
    })
  })
})
