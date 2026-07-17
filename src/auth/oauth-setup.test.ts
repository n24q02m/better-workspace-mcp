import { beforeEach, describe, expect, it, vi } from 'vitest'

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.`
}

const saveTokensMock = vi.fn()
vi.mock('./credential-state.js', () => ({
  getAuth: () => ({ saveTokens: saveTokensMock })
}))

const runHttpServerMock = vi.fn()
vi.mock('@n24q02m/mcp-core', () => ({
  runHttpServer: (...args: unknown[]) => runHttpServerMock(...args)
}))

// Import after the mocks above so oauth-setup.ts binds the mocked modules.
const { deriveSubject, runOAuthSetup, WORKSPACE_SCOPES } = await import('./oauth-setup.js')

describe('deriveSubject', () => {
  it('returns sub when the id_token carries one', () => {
    const idToken = fakeIdToken({ sub: 'google-user-123', email: 'a@example.com' })
    expect(deriveSubject({ id_token: idToken })).toBe('google-user-123')
  })

  it('falls back to email when sub is missing', () => {
    const idToken = fakeIdToken({ email: 'a@example.com' })
    expect(deriveSubject({ id_token: idToken })).toBe('a@example.com')
  })

  it('falls back to local-user when there is no id_token', () => {
    expect(deriveSubject({})).toBe('local-user')
  })
})

describe('runOAuthSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
  })

  it('throws when Google OAuth client credentials are not set', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    await expect(runOAuthSetup()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
    expect(runHttpServerMock).not.toHaveBeenCalled()
  })

  it('requests offline access + saves the delivered tokens, then resolves', async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined)
    let capturedSub: string | undefined

    runHttpServerMock.mockImplementation(async (_factory: () => unknown, options: any) => {
      // Task 0 field: offline access_type + forced consent -> refresh_token.
      expect(options.delegatedOAuth.upstream.authorizeParams).toEqual({
        access_type: 'offline',
        prompt: 'consent'
      })
      expect(options.delegatedOAuth.upstream.scopes).toContain('https://www.googleapis.com/auth/documents')
      expect(options.delegatedOAuth.upstream.scopes).toEqual(WORKSPACE_SCOPES)

      const idToken = fakeIdToken({ sub: 'google-user-123' })
      capturedSub = await options.delegatedOAuth.onTokenReceived({
        id_token: idToken,
        access_token: 'at',
        refresh_token: 'rt'
      })

      return { host: '127.0.0.1', port: 1, close: closeMock }
    })

    await runOAuthSetup()

    expect(capturedSub).toBe('google-user-123')
    expect(saveTokensMock).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'at', refresh_token: 'rt' }))
    expect(closeMock).toHaveBeenCalledOnce()
  })
})
