import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
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
    vi.restoreAllMocks()
    setHomeDirForTesting(null)
    rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('starts as awaiting_setup, resolves to configured after saveTokens, back to awaiting_setup after resetState', async () => {
    expect(getState()).toBe('awaiting_setup')

    await getAuth().saveTokens(
      { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 },
      { email: 'one@example.com' }
    )
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

  it('reports configured when at least one account exists', async () => {
    const auth = getAuth()
    await auth.saveTokens({ access_token: 'at' }, { email: 'a@example.com' })
    expect(await resolveCredentialState()).toBe('configured')
    await auth.clear()
    expect(await resolveCredentialState()).toBe('awaiting_setup')
  })

  it('answers from the account list alone, without building a client', async () => {
    // Building a client is what can reach the network (the legacy-adoption
    // probe). With accounts on disk there is nothing to probe, so the state
    // must be decided from the list -- otherwise `config(action="status")`
    // pays a Google round-trip on every call.
    const auth = getAuth()
    await auth.saveTokens({ access_token: 'at' }, { email: 'a@example.com' })
    const spy = vi.spyOn(auth, 'getAuthenticatedClient')

    expect(await resolveCredentialState()).toBe('configured')

    expect(spy).not.toHaveBeenCalled()
    await auth.clear()
  })

  it('still reports configured for an unadopted legacy blob', async () => {
    // Flat M1 blob with no derivable email: listAccounts() is empty, so the
    // state falls back to asking getAuthenticatedClient(), which adopts it.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at' })
    const auth = getAuth()
    vi.spyOn(
      auth as unknown as { fetchAccountEmail: (client: unknown) => Promise<string | undefined> },
      'fetchAccountEmail'
    ).mockResolvedValue('adopted@example.com')

    expect(await resolveCredentialState()).toBe('configured')
    expect((await auth.listAccounts()).accounts).toEqual(['adopted@example.com'])
    await auth.clear()
  })
})
