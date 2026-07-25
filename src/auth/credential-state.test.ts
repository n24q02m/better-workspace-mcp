import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
import { getAuth, getState, resetState, resolveCredentialState } from './credential-state.js'
import { runWithSubject } from './subject-context.js'

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

  describe('per-subject buckets', () => {
    // Xem ghi chú ở account-store.test.ts: nhánh sub cần CREDENTIAL_SECRET.
    // Mỗi test dùng tên sub RIÊNG vì hai Map cache của module sống qua cả file
    // (home dir thì mới mỗi test) -- tên riêng làm mỗi test độc lập thật, thay
    // vì phụ thuộc thứ tự chạy.
    const originalSecret = process.env.CREDENTIAL_SECRET

    beforeEach(() => {
      process.env.CREDENTIAL_SECRET = 'test-credential-secret-at-least-32-chars'
    })
    afterEach(() => {
      if (originalSecret === undefined) delete process.env.CREDENTIAL_SECRET
      else process.env.CREDENTIAL_SECRET = originalSecret
    })

    it('hands out one WorkspaceAuth per subject and reuses it', async () => {
      // getAuth() nằm trên đường nóng của MỌI tool call (registry -> AuthManager
      // shim), nên nó phải cache; nhưng cache phải keyed theo sub, nếu không thì
      // hai người dùng chung một AccountStore.
      const first = await runWithSubject('cache-a', async () => getAuth())
      const again = await runWithSubject('cache-a', async () => getAuth())
      const other = await runWithSubject('cache-b', async () => getAuth())

      expect(again).toBe(first)
      expect(other).not.toBe(first)
      expect(getAuth()).not.toBe(first) // bucket stdio cũng là một instance riêng
    })

    it('keeps each subject accounts out of the other subject list', async () => {
      await runWithSubject('iso-a', async () => {
        await getAuth().saveTokens({ access_token: 'a-at' }, { email: 'alice@example.com' })
      })
      await runWithSubject('iso-b', async () => {
        await getAuth().saveTokens({ access_token: 'b-at' }, { email: 'bob@example.com' })
      })

      const seenByA = await runWithSubject('iso-a', async () => (await getAuth().listAccounts()).accounts)
      const seenByB = await runWithSubject('iso-b', async () => (await getAuth().listAccounts()).accounts)

      expect(seenByA).toEqual(['alice@example.com'])
      expect(seenByB).toEqual(['bob@example.com'])
      // Ngoài mọi subject scope = bucket stdio, và nó không thấy gì của hai người trên.
      expect((await getAuth().listAccounts()).accounts).toEqual([])
    })

    it('resets only the calling subject bucket', async () => {
      // resetState() phải đi qua getAuth(): nếu nó giữ một instance singleton thì
      // setup_reset của một người dùng remote vừa KHÔNG xoá credential của chính
      // họ, vừa xoá mất bucket của người khác.
      await runWithSubject('reset-a', async () => {
        await getAuth().saveTokens({ access_token: 'a-at' }, { email: 'alice@example.com' })
      })
      await runWithSubject('reset-b', async () => {
        await getAuth().saveTokens({ access_token: 'b-at' }, { email: 'bob@example.com' })
      })

      await runWithSubject('reset-a', async () => {
        await resetState()
      })

      expect(await runWithSubject('reset-a', async () => (await getAuth().listAccounts()).accounts)).toEqual([])
      expect(await runWithSubject('reset-b', async () => (await getAuth().listAccounts()).accounts)).toEqual([
        'bob@example.com'
      ])
    })

    it('tracks configured/awaiting_setup per subject', async () => {
      // getState() gác mọi domain tool (registry.ts:224). Một biến state dùng
      // chung nghĩa là setup_reset của người này khoá tool của người kia.
      await runWithSubject('state-a', async () => {
        await getAuth().saveTokens({ access_token: 'a-at' }, { email: 'alice@example.com' })
        expect(await resolveCredentialState()).toBe('configured')
      })
      await runWithSubject('state-b', async () => {
        await getAuth().saveTokens({ access_token: 'b-at' }, { email: 'bob@example.com' })
        expect(await resolveCredentialState()).toBe('configured')
      })

      await runWithSubject('state-a', async () => {
        await resetState()
      })

      expect(await runWithSubject('state-a', async () => getState())).toBe('awaiting_setup')
      expect(await runWithSubject('state-b', async () => getState())).toBe('configured')
    })
  })
})
