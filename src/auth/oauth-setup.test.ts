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
const { deriveSubject, deriveSubjectStrict, runOAuthSetup, WORKSPACE_SCOPES } = await import('./oauth-setup.js')

const GRACE_MS = 20

/**
 * mcp-core is mocked, so nothing calls `onTokenReceived` on its own: capture it, start the
 * flow without awaiting it (it only settles once a consent lands), then drive the tabs from
 * the test body -- which is the only way to reach a tab arriving AFTER the flow settled.
 */
function startSetup(opts: { graceMs?: number } = {}) {
  const close = vi.fn().mockResolvedValue(undefined)
  let onToken: ((t: Record<string, unknown>) => Promise<string>) | undefined
  runHttpServerMock.mockImplementation(async (_factory: () => unknown, options: any) => {
    onToken = options.delegatedOAuth.onTokenReceived
    return { host: '127.0.0.1', port: 1, close }
  })
  const done = runOAuthSetup(opts)
  return {
    close,
    done,
    /** The raw callback, for tests that must fire two tabs with no await in between. */
    rawOnToken: () => onToken,
    consent: async (claims: Record<string, unknown>) => {
      await vi.waitFor(() => expect(onToken).toBeDefined())
      return (onToken as (t: Record<string, unknown>) => Promise<string>)({
        id_token: fakeIdToken(claims),
        access_token: 'at'
      })
    },
    // The grace close is timer-driven; a test that gets there must wait for it, and must
    // not leave it pending for a later test to trip over.
    drainGrace: () => vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 })
  }
}

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

  it('falls back to local-user when the id_token has an empty payload segment', () => {
    // 'header.' -> split('.')[1] === '' (falsy), never reaches the JSON.parse branch.
    expect(deriveSubject({ id_token: 'header.' })).toBe('local-user')
  })

  it('falls back to local-user when the payload decodes but has neither sub nor email', () => {
    const idToken = fakeIdToken({ aud: 'some-client-id' })
    expect(deriveSubject({ id_token: idToken })).toBe('local-user')
  })
})

describe('deriveSubjectStrict', () => {
  // Ở stdio, `'local-user'` vô hại: một người dùng, một bucket. Ở remote thì MỌI
  // người dùng không suy được danh tính sẽ dồn vào cùng bucket tên đó -- đúng cái
  // silent fallback mà mcp-dev invariant 7 tồn tại để chặn, chỉ là ở đường GHI.
  // Nên remote dùng bản strict này; nó ném chứ không bao giờ trả sentinel.
  it('returns sub when the id_token carries one', () => {
    const idToken = fakeIdToken({ sub: 'google-user-123', email: 'a@example.com' })
    expect(deriveSubjectStrict({ id_token: idToken })).toBe('google-user-123')
  })

  it('falls back to email when sub is missing', () => {
    const idToken = fakeIdToken({ email: 'a@example.com' })
    expect(deriveSubjectStrict({ id_token: idToken })).toBe('a@example.com')
  })

  it('throws when there is no id_token', () => {
    expect(() => deriveSubjectStrict({})).toThrow(/no usable/i)
  })

  it('throws when the id_token has an empty payload segment', () => {
    expect(() => deriveSubjectStrict({ id_token: 'header.' })).toThrow(/no usable/i)
  })

  it('throws when the payload is not decodable JSON', () => {
    expect(() => deriveSubjectStrict({ id_token: 'header.!!!not-json!!!.sig' })).toThrow(/no usable/i)
  })

  it('throws when the payload decodes but has neither sub nor email', () => {
    const idToken = fakeIdToken({ aud: 'some-client-id' })
    expect(() => deriveSubjectStrict({ id_token: idToken })).toThrow(/no usable/i)
  })

  it('throws on an empty-string sub instead of treating it as an identity', () => {
    const idToken = fakeIdToken({ sub: '', email: '' })
    expect(() => deriveSubjectStrict({ id_token: idToken })).toThrow(/no usable/i)
  })

  it('names the isolation reason, not just the parse failure', () => {
    // Người đọc log phải hiểu vì sao bị từ chối: không có subject thì không có
    // cách nào cách ly credential, chứ không phải "id_token hơi lạ".
    expect(() => deriveSubjectStrict({})).toThrow(/isolat/i)
  })
})

describe('WORKSPACE_SCOPES', () => {
  it('requests the Forms scopes up front so M4 needs no second consent', () => {
    expect(WORKSPACE_SCOPES).toContain('https://www.googleapis.com/auth/forms.body')
    expect(WORKSPACE_SCOPES).toContain('https://www.googleapis.com/auth/forms.responses.readonly')
  })

  it('does not request forms.body.readonly, which forms.body already covers', () => {
    expect(WORKSPACE_SCOPES).not.toContain('https://www.googleapis.com/auth/forms.body.readonly')
  })
})

describe('runOAuthSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // WorkspaceAuth.saveTokens resolves with the email it stored; the flow now compares a
    // late tab against that, so the mock has to honour the real signature rather than the
    // bare undefined that only worked while the result was awaited and discarded.
    saveTokensMock.mockResolvedValue('setup@example.com')
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

    runHttpServerMock.mockImplementation(async (factory: () => unknown, options: any) => {
      // Exercise the real serverFactory lambda (constructs the placeholder
      // Server passed to mcp-core's runHttpServer) -- mcp-core itself is
      // mocked here and never calls it on its own.
      expect(factory()).toBeDefined()

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

    await runOAuthSetup({ graceMs: GRACE_MS })

    expect(capturedSub).toBe('google-user-123')
    expect(saveTokensMock).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'at', refresh_token: 'rt' }))
    // When the server closes is asserted by the grace tests below.
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 })
  })

  it('leaves the callback port open after a successful consent, then closes it once', async () => {
    const flow = startSetup({ graceMs: GRACE_MS })
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })

    await flow.done
    // Startup carries on immediately; the port is what lingers, not the boot.
    expect(flow.close).not.toHaveBeenCalled()

    await flow.drainGrace()
  })

  it('does not make startup wait out the grace window', async () => {
    vi.useFakeTimers()
    try {
      const flow = startSetup()
      await flow.consent({ sub: 'google-user-123' })

      // No timer advanced: if the flow only settled after the grace window, this hangs.
      await flow.done
      expect(flow.close).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(9_999)
      expect(flow.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(flow.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a late tab for the SAME account without saving twice', async () => {
    saveTokensMock.mockResolvedValue('a@example.com')
    const flow = startSetup({ graceMs: GRACE_MS })
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done

    await expect(flow.consent({ sub: 'google-user-123', email: 'a@example.com' })).resolves.toBe('google-user-123')
    expect(saveTokensMock).toHaveBeenCalledTimes(1)

    await flow.drainGrace()
  })

  it('refuses a late tab for a DIFFERENT account instead of storing it', async () => {
    saveTokensMock.mockResolvedValue('a@example.com')
    const flow = startSetup({ graceMs: GRACE_MS })
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done

    await expect(flow.consent({ sub: 'google-user-999', email: 'b@example.com' })).rejects.toThrow(/a@example\.com/)
    expect(saveTokensMock).toHaveBeenCalledTimes(1)

    await flow.drainGrace()
  })

  it('lets only the first of two SIMULTANEOUS tabs save', async () => {
    // A slow save plus two calls with NO await between them: the second tab is guaranteed
    // to arrive while the first save is still in flight, which is where a flag set after
    // that await would still read as unset.
    saveTokensMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'a@example.com'
    })
    const flow = startSetup({ graceMs: GRACE_MS })
    await vi.waitFor(() => expect(flow.rawOnToken()).toBeDefined())
    const onToken = flow.rawOnToken() as (t: Record<string, unknown>) => Promise<string>

    const first = onToken({ id_token: fakeIdToken({ sub: 'google-user-123', email: 'a@example.com' }) })
    const second = onToken({ id_token: fakeIdToken({ sub: 'google-user-999', email: 'b@example.com' }) })

    await expect(first).resolves.toBe('google-user-123')
    await expect(second).rejects.toThrow(/a@example\.com/)
    expect(saveTokensMock).toHaveBeenCalledTimes(1)

    await flow.done
    await flow.drainGrace()
  })

  it('tells the user a tab was already opened rather than inviting a second consent', async () => {
    const writes: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    // This machine's shell sets MCP_NO_BROWSER; CI does not. Save and restore rather than
    // assuming either, or the restore itself leaks a value into the next test.
    const priorNoBrowser = process.env.MCP_NO_BROWSER
    try {
      delete process.env.MCP_NO_BROWSER
      const flow = startSetup({ graceMs: GRACE_MS })
      await flow.consent({ sub: 'google-user-123' })
      await flow.done
      await flow.drainGrace()

      const line = writes.join('')
      expect(line).toMatch(/http:\/\/127\.0\.0\.1:1\//)
      expect(line).toMatch(/should have opened|only if it did not/i)
      // The old wording read as the instruction: "Open <url> in a browser to authorize".
      expect(line).not.toMatch(/^\[[^\]]+\] Open http/m)
    } finally {
      stderrSpy.mockRestore()
      if (priorNoBrowser === undefined) delete process.env.MCP_NO_BROWSER
      else process.env.MCP_NO_BROWSER = priorNoBrowser
    }
  })

  it('falls back to plain instructions when auto-open is switched off', async () => {
    const writes: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const priorNoBrowser = process.env.MCP_NO_BROWSER
    try {
      process.env.MCP_NO_BROWSER = '1'
      const flow = startSetup({ graceMs: GRACE_MS })
      await flow.consent({ sub: 'google-user-123' })
      await flow.done
      await flow.drainGrace()

      // No tab opens here, so promising one would be a lie.
      expect(writes.join('')).not.toMatch(/should have opened/i)
      expect(writes.join('')).toMatch(/http:\/\/127\.0\.0\.1:1\//)
    } finally {
      stderrSpy.mockRestore()
      if (priorNoBrowser === undefined) delete process.env.MCP_NO_BROWSER
      else process.env.MCP_NO_BROWSER = priorNoBrowser
    }
  })

  // Regression test: a saveTokens disk error used to leave `finished` unresolved
  // forever (no reject path), hanging runOAuthSetup with no timeout and no stderr.
  // Short test timeout so a reintroduced hang fails fast instead of stalling the suite.
  it('rejects (does not hang) and still closes the server when saveTokens throws', async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined)
    const saveError = new Error('EACCES: disk write failed')
    saveTokensMock.mockRejectedValueOnce(saveError)

    runHttpServerMock.mockImplementation(async (_factory: () => unknown, options: any) => {
      const idToken = fakeIdToken({ sub: 'google-user-123' })
      await expect(
        options.delegatedOAuth.onTokenReceived({
          id_token: idToken,
          access_token: 'at',
          refresh_token: 'rt'
        })
      ).rejects.toThrow(saveError)

      return { host: '127.0.0.1', port: 1, close: closeMock }
    })

    await expect(runOAuthSetup()).rejects.toThrow(saveError)
    expect(closeMock).toHaveBeenCalledOnce()
  }, 1000)
})
