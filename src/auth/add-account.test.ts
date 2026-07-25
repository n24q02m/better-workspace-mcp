import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const closeSpy = vi.fn(async () => {})
let capturedOnToken: ((tokens: Record<string, unknown>) => Promise<string>) | undefined
let capturedAuthorizeParams: Record<string, string> | undefined
let capturedServer: unknown

vi.mock('@n24q02m/mcp-core', () => ({
  runHttpServer: async (
    factory: () => unknown,
    options: {
      delegatedOAuth: {
        upstream: { authorizeParams?: Record<string, string> }
        onTokenReceived: (t: Record<string, unknown>) => Promise<string>
      }
    }
  ) => {
    // Exercise the real serverFactory lambda -- mcp-core is mocked here and would
    // never call it otherwise (same reason oauth-setup.test.ts does this).
    capturedServer = factory()
    capturedOnToken = options.delegatedOAuth.onTokenReceived
    capturedAuthorizeParams = options.delegatedOAuth.upstream.authorizeParams
    return { host: '127.0.0.1', port: 41234, close: closeSpy }
  }
}))

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
const idToken = (email: string) => `${b64({ alg: 'none' })}.${b64({ email, sub: 'goog-sub' })}.sig`

// Imported after the mock above so add-account.ts binds the mocked mcp-core, and at
// module level rather than inside a test: this graph pulls in googleapis, which costs
// ~3s to load. Paid inside the first `it`, that lands under the 5s testTimeout and
// times out whenever the suite runs under load (leaving an in-flight credential write
// to fail EPERM against the temp home afterEach has already removed).
const { startAddAccount } = await import('./add-account.js')
const { getAuth } = await import('./credential-state.js')

describe('startAddAccount', () => {
  let home: string

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    home = mkdtempSync(join(tmpdir(), 'bws-addaccount-test-'))
    setHomeDirForTesting(home)
    closeSpy.mockClear()
    capturedOnToken = undefined
  })
  afterEach(() => {
    setHomeDirForTesting(null)
    rmSync(home, { recursive: true, force: true })
  })

  it('returns a local URL to open and resolves with the added account email', async () => {
    const flow = await startAddAccount()
    expect(flow.url).toBe('http://127.0.0.1:41234/')
    expect(capturedServer).toBeDefined()

    await capturedOnToken?.({ access_token: 'at-new', refresh_token: 'rt-new', id_token: idToken('new@example.com') })

    expect(await flow.done).toBe('new@example.com')
    expect((await getAuth().listAccounts()).accounts).toContain('new@example.com')
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('requests offline access so Google returns a refresh_token', async () => {
    await startAddAccount()
    expect(capturedAuthorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' })
  })

  it('promotes the new account to primary when asked', async () => {
    await getAuth().saveTokens({ access_token: 'at-old' }, { email: 'old@example.com' })

    const flow = await startAddAccount({ makePrimary: true })
    await capturedOnToken?.({ access_token: 'at-new', id_token: idToken('new@example.com') })
    await flow.done

    expect((await getAuth().listAccounts()).primary).toBe('new@example.com')
  })

  it('rejects when the account has no email claim, and still shuts the server down', async () => {
    const flow = await startAddAccount()
    const rejected = expect(flow.done).rejects.toThrow(/email/i)
    await expect(capturedOnToken?.({ access_token: 'at', id_token: idToken('') })).rejects.toThrow()
    await rejected
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('closes the temporary server when the user never finishes the consent', async () => {
    const flow = await startAddAccount({ ttlMs: 20 })

    await expect(flow.done).rejects.toThrow(/timed out/i)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('fails fast when the OAuth client env vars are missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    await expect(startAddAccount()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
  })
})
