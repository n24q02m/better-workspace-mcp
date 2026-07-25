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

const GRACE_MS = 20

/**
 * The post-success shutdown is timer-driven, so a test that gets there has to wait for
 * it -- and must not leave it pending: an unawaited grace timer fires inside a LATER
 * test and inflates that test's closeSpy count.
 */
const drainGrace = () => vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 })

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
    const flow = await startAddAccount({ graceMs: GRACE_MS })
    expect(flow.url).toBe('http://127.0.0.1:41234/')
    expect(capturedServer).toBeDefined()

    await capturedOnToken?.({ access_token: 'at-new', refresh_token: 'rt-new', id_token: idToken('new@example.com') })

    expect(await flow.done).toBe('new@example.com')
    expect((await getAuth().listAccounts()).accounts).toContain('new@example.com')
    // When the server closes is asserted by the grace tests below.
    await drainGrace()
  })

  it('leaves the callback server listening after success so a late consent tab still lands', async () => {
    const flow = await startAddAccount({ graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at', id_token: idToken('late-tab@example.com') })

    // The caller learns the outcome at once -- it does not wait out the grace window.
    expect(await flow.done).toBe('late-tab@example.com')
    expect(closeSpy).not.toHaveBeenCalled()

    await drainGrace()
  })

  it('accepts a late tab that consented as the SAME account, without writing twice', async () => {
    const flow = await startAddAccount({ graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at-1', id_token: idToken('same@example.com') })
    expect(await flow.done).toBe('same@example.com')

    // Second tab, still inside the grace window, same Google account.
    await expect(capturedOnToken?.({ access_token: 'at-2', id_token: idToken('same@example.com') })).resolves.toBe(
      'same@example.com'
    )

    const { accounts } = await getAuth().listAccounts()
    expect(accounts).toEqual(['same@example.com'])
    await drainGrace()
  })

  it('refuses a late tab that consented as a DIFFERENT account instead of silently adding it', async () => {
    const flow = await startAddAccount({ graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at-a', id_token: idToken('a@example.com') })
    expect(await flow.done).toBe('a@example.com')

    // The user picked another identity in Google's account chooser on the second tab.
    await expect(capturedOnToken?.({ access_token: 'at-b', id_token: idToken('b@example.com') })).rejects.toThrow(
      /a@example\.com/
    )

    const { accounts } = await getAuth().listAccounts()
    expect(accounts).toEqual(['a@example.com'])
    expect(accounts).not.toContain('b@example.com')
    await drainGrace()
  })

  it('does not let a late tab steal primary', async () => {
    const flow = await startAddAccount({ makePrimary: true, graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at-a', id_token: idToken('a@example.com') })
    await flow.done

    await expect(capturedOnToken?.({ access_token: 'at-b', id_token: idToken('b@example.com') })).rejects.toThrow()

    expect((await getAuth().listAccounts()).primary).toBe('a@example.com')
    await drainGrace()
  })

  it('lets only the first of two SIMULTANEOUS tabs write, before either save finishes', async () => {
    // The prefetch case: both callbacks start before the first save resolves, so a flag
    // set after the await would still be null for the second one.
    const flow = await startAddAccount({ graceMs: GRACE_MS })
    const first = capturedOnToken?.({ access_token: 'at-a', id_token: idToken('a@example.com') })
    const second = capturedOnToken?.({ access_token: 'at-b', id_token: idToken('b@example.com') })

    await expect(first).resolves.toBe('a@example.com')
    await expect(second).rejects.toThrow(/a@example\.com/)

    expect((await getAuth().listAccounts()).accounts).toEqual(['a@example.com'])
    expect(await flow.done).toBe('a@example.com')
    await drainGrace()
  })

  it('holds the port for ten seconds by default, which is what ships', async () => {
    vi.useFakeTimers()
    try {
      const flow = await startAddAccount()
      await capturedOnToken?.({ access_token: 'at', id_token: idToken('default-grace@example.com') })
      await flow.done

      await vi.advanceTimersByTimeAsync(9_999)
      expect(closeSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the server once, no matter how many places await the flow', async () => {
    const flow = await startAddAccount({ graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at', id_token: idToken('shared@example.com') })

    await Promise.all([flow.done, flow.done, flow.done.then((e) => e.toUpperCase())])
    await drainGrace()

    // Still one after another full grace window: awaiting does not schedule a close.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3))
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('reports a failed shutdown on stderr rather than dropping it or failing the flow', async () => {
    closeSpy.mockRejectedValueOnce(new Error('port stuck'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const flow = await startAddAccount({ graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at', id_token: idToken('noisy@example.com') })

    // The consent succeeded; a cleanup failure must not be reported as the flow's outcome.
    expect(await flow.done).toBe('noisy@example.com')
    await drainGrace()
    await vi.waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to close'), expect.any(Error))
    )

    errSpy.mockRestore()
  })

  it('requests offline access so Google returns a refresh_token', async () => {
    await startAddAccount()
    expect(capturedAuthorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' })
  })

  it('promotes the new account to primary when asked', async () => {
    await getAuth().saveTokens({ access_token: 'at-old' }, { email: 'old@example.com' })

    const flow = await startAddAccount({ makePrimary: true, graceMs: GRACE_MS })
    await capturedOnToken?.({ access_token: 'at-new', id_token: idToken('new@example.com') })
    await flow.done

    expect((await getAuth().listAccounts()).primary).toBe('new@example.com')
    await drainGrace()
  })

  it('rejects when the account has no email claim, and still shuts the server down', async () => {
    const flow = await startAddAccount()
    const rejected = expect(flow.done).rejects.toThrow(/email/i)
    await expect(capturedOnToken?.({ access_token: 'at', id_token: idToken('') })).rejects.toThrow()
    await rejected
    // No grace on a failure: nothing was saved, so a second tab has nothing to land on.
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('closes the temporary server when the user never finishes the consent', async () => {
    const flow = await startAddAccount({ ttlMs: 20 })

    await expect(flow.done).rejects.toThrow(/timed out/i)
    // Nobody is mid-consent when the deadline hits -- close now, do not hold the port.
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('fails fast when the OAuth client env vars are missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    await expect(startAddAccount()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
  })
})
