import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAuth, getState, resetState, resolveCredentialState } from './credential-state.js'

describe('credential-state', () => {
  let testHomeDir: string

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    testHomeDir = mkdtempSync(join(tmpdir(), 'better-workspace-mcp-test-'))
    setHomeDirForTesting(testHomeDir)
  })

  afterEach(() => {
    setHomeDirForTesting(null)
    rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('starts as awaiting_setup, resolves to configured after saveTokens, back to awaiting_setup after resetState', async () => {
    expect(getState()).toBe('awaiting_setup')

    await getAuth().saveTokens({ access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 })
    expect(await resolveCredentialState()).toBe('configured')
    expect(getState()).toBe('configured')

    await resetState()
    expect(getState()).toBe('awaiting_setup')
  })

  it('falls back to awaiting_setup when getAuthenticatedClient() throws (no token stored)', async () => {
    // No saveTokens call -- getAuthenticatedClient() throws 'not configured',
    // exercising resolveCredentialState()'s catch branch.
    expect(await resolveCredentialState()).toBe('awaiting_setup')
    expect(getState()).toBe('awaiting_setup')
  })
})
