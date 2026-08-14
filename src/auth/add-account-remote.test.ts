import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_CALLBACK_PATH,
  accountCallbackRoute,
  buildAddAccountUrl,
  claimNonce,
  handleAccountCallback,
  resetNonceStoreForTesting,
  STATE_TTL_MS,
  signState,
  verifyState
} from './add-account-remote.js'

const SECRET = 'test-secret-at-least-32-chars-long-xx'

function setEnv(): void {
  process.env.CREDENTIAL_SECRET = SECRET
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
  process.env.PUBLIC_URL = 'https://workspace.example.com'
}

function fakeRes() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
    get status(): number {
      return this.writeHead.mock.calls[0]?.[0] as number
    },
    get body(): string {
      return (this.end.mock.calls[0]?.[0] as string) ?? ''
    },
    get headers(): Record<string, string> {
      return (this.writeHead.mock.calls[0]?.[1] as Record<string, string>) ?? {}
    }
  }
}

function get(path: string) {
  return { url: path, headers: {} } as never
}

beforeEach(() => {
  setEnv()
  resetNonceStoreForTesting()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('state token', () => {
  it('round-trips the subject', () => {
    expect(verifyState(signState('sub-1'))?.sub).toBe('sub-1')
  })

  // The state must not be able to grant the default-account slot, because
  // whoever gets hold of it -- by replay or by racing the real user -- would
  // otherwise point every untargeted tool call at their own mailbox.
  it('never carries a make-primary flag, whatever the caller passes', () => {
    const state = signState('sub-1', { makePrimary: true } as never)
    const claims = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8'))
    expect(claims).not.toHaveProperty('mp')
    expect(Object.keys(claims).sort()).toEqual(['exp', 'n', 'sub'])
  })

  it('rejects a tampered payload', () => {
    const [body, mac] = signState('sub-1').split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker', exp: Date.now() + 60_000, n: 'x' }), 'utf8').toString(
      'base64url'
    )
    expect(verifyState(`${forged}.${mac}`)).toBeNull()
    // ...and the original still verifies, so the test is about the swap.
    expect(verifyState(`${body}.${mac}`)?.sub).toBe('sub-1')
  })

  it('rejects a state signed with a different secret', () => {
    const state = signState('sub-1')
    process.env.CREDENTIAL_SECRET = 'a-completely-different-secret-value-yy'
    expect(verifyState(state)).toBeNull()
  })

  it('rejects an expired state', () => {
    const state = signState('sub-1')
    expect(verifyState(state, Date.now() + STATE_TTL_MS + 1)).toBeNull()
  })

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'not-a-state', '.', 'a.b', '.abc']) {
      expect(verifyState(bad)).toBeNull()
    }
  })

  it('two flows for the same subject produce different states', () => {
    expect(signState('sub-1')).not.toBe(signState('sub-1'))
  })

  // The whole reason this is an HMAC and not JWTIssuer.issueAccessToken(): a
  // state travels in a URL, through browser history and Google's Referer, so it
  // must not be a credential. A JWT would be `header.payload.signature`; this is
  // two segments and carries no `typ`/`iss`/`aud`, so /mcp's verifier cannot
  // accept it even if someone lifts it out of a log.
  it('is not shaped like a JWT access token', () => {
    const state = signState('sub-1')
    expect(state.split('.')).toHaveLength(2)
    const claims = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8'))
    expect(claims).not.toHaveProperty('typ')
    expect(claims).not.toHaveProperty('iss')
    expect(claims).not.toHaveProperty('aud')
  })

  it('refuses to sign without CREDENTIAL_SECRET', () => {
    process.env.CREDENTIAL_SECRET = ''
    expect(() => signState('sub-1')).toThrow(/CREDENTIAL_SECRET/)
  })
})

describe('buildAddAccountUrl', () => {
  it('targets Google with the registered redirect URI and offline params', () => {
    const url = new URL(buildAddAccountUrl('sub-1'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('redirect_uri')).toBe('https://workspace.example.com/accounts/callback')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('cid')
  })

  it('asks for the Forms scopes so M4 needs no re-consent', () => {
    const scope = new URL(buildAddAccountUrl('sub-1')).searchParams.get('scope') ?? ''
    expect(scope).toContain('https://www.googleapis.com/auth/forms.body')
    expect(scope).toContain('https://www.googleapis.com/auth/drive')
  })

  it('carries the calling subject in the state, not in a readable param', () => {
    const url = new URL(buildAddAccountUrl('sub-1'))
    expect(url.searchParams.get('sub')).toBeNull()
    expect(verifyState(url.searchParams.get('state') ?? '')?.sub).toBe('sub-1')
  })

  it('normalises a PUBLIC_URL with a trailing slash (Google compares it exactly)', () => {
    process.env.PUBLIC_URL = 'https://workspace.example.com/'
    expect(new URL(buildAddAccountUrl('s')).searchParams.get('redirect_uri')).toBe(
      'https://workspace.example.com/accounts/callback'
    )
  })

  it('refuses without PUBLIC_URL rather than sending Google a URI it will reject', () => {
    process.env.PUBLIC_URL = ''
    expect(() => buildAddAccountUrl('sub-1')).toThrow(/PUBLIC_URL/)
  })

  it('refuses without a client id', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = ''
    expect(() => buildAddAccountUrl('sub-1')).toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
  })
})

describe('route registration', () => {
  it('is a GET on the path registered with Google', () => {
    expect(accountCallbackRoute()).toMatchObject({ method: 'GET', path: '/accounts/callback' })
    expect(ACCOUNT_CALLBACK_PATH).toBe('/accounts/callback')
  })
})

describe('callback gate', () => {
  it('refuses a callback with no state and renders nothing else', async () => {
    const res = fakeRes()
    await handleAccountCallback(get('/accounts/callback?code=abc'), res as never)
    expect(res.status).toBe(400)
    expect(res.body).not.toContain('abc')
    expect(res.body).toContain('<svg aria-hidden="true"')
    expect(res.body).toContain('class="feedback-icon feedback-icon--error"')
    expect(res.body).toContain('<circle cx="12" cy="12" r="10"></circle>')
    expect(res.body).not.toContain('class="feedback-icon feedback-icon--success"')
    expect(res.body).not.toContain(' style=')
    const css = res.body.match(/<style>([\s\S]+)<\/style>/)?.[1]
    expect(css).toBeTruthy()
    const expectedStyleHash = createHash('sha256')
      .update(css ?? '')
      .digest('base64')
    expect(res.headers['Content-Security-Policy']).toBe(`default-src 'none'; style-src 'sha256-${expectedStyleHash}'`)
    expect(res.writeHead).toHaveBeenCalledWith(
      400,
      expect.objectContaining({
        'content-type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': expect.stringContaining("default-src 'none'"),
        'X-Frame-Options': 'DENY',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Cache-Control': 'no-store'
      })
    )
  })

  it('refuses a state that does not verify', async () => {
    const res = fakeRes()
    await handleAccountCallback(get('/accounts/callback?code=abc&state=not-a-state'), res as never)
    expect(res.status).toBe(400)
  })

  it('refuses an expired state', async () => {
    vi.useFakeTimers()
    try {
      const state = signState('sub-1')
      vi.advanceTimersByTime(STATE_TTL_MS + 1000)
      const res = fakeRes()
      await handleAccountCallback(get(`/accounts/callback?code=abc&state=${state}`), res as never)
      expect(res.status).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })

  // A caller with no valid state gets the same 400 whether or not they also sent
  // an `error`, so probing cannot distinguish the two.
  it('checks the state before a Google error param', async () => {
    const res = fakeRes()
    await handleAccountCallback(get('/accounts/callback?error=access_denied'), res as never)
    expect(res.status).toBe(400)
    expect(res.body).not.toContain('access_denied')
  })

  it('reports a Google denial once the state is valid', async () => {
    const res = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?error=access_denied&state=${signState('sub-1')}`), res as never)
    expect(res.status).toBe(400)
    expect(res.body).toContain('access_denied')
  })

  it('refuses a valid state with no code', async () => {
    const res = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?state=${signState('sub-1')}`), res as never)
    expect(res.status).toBe(400)
  })

  it('never reflects the state back into the page', async () => {
    const state = signState('sub-1')
    const res = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?state=${state}`), res as never)
    expect(res.body).not.toContain(state)
  })
})

describe('nonce claim (single-use state)', () => {
  it('claims a fresh nonce once and refuses it after', async () => {
    expect(await claimNonce('n1', Date.now() + 60_000)).toBe(true)
    expect(await claimNonce('n1', Date.now() + 60_000)).toBe(false)
  })

  it('lets an expired spent marker be reclaimed (the state it belonged to is dead anyway)', async () => {
    const exp = Date.now() + 60_000
    expect(await claimNonce('n2', exp)).toBe(true)
    expect(await claimNonce('n2', exp, exp + 1)).toBe(true)
  })

  it('keeps separate nonces independent', async () => {
    expect(await claimNonce('a', Date.now() + 60_000)).toBe(true)
    expect(await claimNonce('b', Date.now() + 60_000)).toBe(true)
  })
})

describe('callback success path', () => {
  const saveTokens = vi.fn(async () => 'added@example.com')
  const seenSubjects: (string | undefined)[] = []

  beforeEach(async () => {
    saveTokens.mockClear()
    seenSubjects.length = 0
    const { currentSubject } = await import('./subject-context.js')
    const credentialState = await import('./credential-state.js')
    vi.spyOn(credentialState, 'getAuth').mockImplementation(() => {
      seenSubjects.push(currentSubject())
      return { saveTokens } as never
    })
    vi.spyOn(credentialState, 'resolveCredentialState').mockResolvedValue('configured')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'at', id_token: 'x' }), { status: 200 }))
    )
  })

  it('stores the account inside the subject scope taken from the state', async () => {
    const res = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=abc&state=${signState('sub-from-jwt')}`), res as never)
    expect(res.status).toBe(200)
    expect(res.body).toContain('added@example.com')
    expect(res.body).toContain('<svg aria-hidden="true"')
    expect(res.body).toContain('class="feedback-icon feedback-icon--success"')
    expect(res.body).toContain('<polyline points="22 4 12 14.01 9 11.01"></polyline>')
    expect(res.body).not.toContain('class="feedback-icon feedback-icon--error"')
    expect(res.body).not.toContain(' style=')
    expect(res.body).toContain('<h1>Account added</h1>')
    // The bucket comes from the CALLER's JWT sub, never from the new account.
    expect(seenSubjects).toEqual(['sub-from-jwt'])
  })

  it('never asks the store to promote the new account', async () => {
    await handleAccountCallback(get(`/accounts/callback?code=abc&state=${signState('s')}`), fakeRes() as never)
    // Called with the tokens alone: no options object, so no makePrimary to
    // honour. AccountStore still promotes into an EMPTY bucket on its own --
    // that is its invariant (a bucket of accounts with no working primary is
    // broken), not something this flow can be asked to grant.
    expect(saveTokens).toHaveBeenCalledWith(expect.anything())
    expect(saveTokens.mock.calls[0]).toHaveLength(1)
  })

  it('sends the same redirect_uri to the token endpoint that it sent to authorize', async () => {
    await handleAccountCallback(get(`/accounts/callback?code=abc&state=${signState('s')}`), fakeRes() as never)
    const body = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body as URLSearchParams
    // Google rejects the exchange with invalid_grant if these differ.
    expect(body.get('redirect_uri')).toBe('https://workspace.example.com/accounts/callback')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('abc')
  })

  it('reports a failed token exchange without storing anything', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid_grant', { status: 400 }))
    )
    const res = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=abc&state=${signState('s')}`), res as never)
    expect(res.status).toBe(500)
    expect(saveTokens).not.toHaveBeenCalled()
  })

  it('escapes the stored email into the page', async () => {
    saveTokens.mockResolvedValueOnce('<script>alert(1)</script>@x.com' as never)
    const res = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=abc&state=${signState('s')}`), res as never)
    expect(res.body).not.toContain('<script>')
    expect(res.body).toContain('&lt;script&gt;')
  })

  // Two consents for one user arriving together must not interleave: AccountStore.put
  // is read-modify-write over a single blob written with write-then-rename.
  it('serialises two concurrent callbacks for the same subject', async () => {
    let inFlight = 0
    let overlapped = false
    saveTokens.mockImplementation(async () => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((r) => setTimeout(r, 10))
      inFlight -= 1
      return 'added@example.com'
    })
    // TWO SEPARATE flows for one user (two account_add calls). The same state
    // twice is the replay case and is covered below -- it is refused, so it
    // could not exercise the write queue.
    await Promise.all([
      handleAccountCallback(get(`/accounts/callback?code=a&state=${signState('same-sub')}`), fakeRes() as never),
      handleAccountCallback(get(`/accounts/callback?code=b&state=${signState('same-sub')}`), fakeRes() as never)
    ])
    expect(overlapped).toBe(false)
    expect(saveTokens).toHaveBeenCalledTimes(2)
  })

  it('keeps two different subjects in their own scopes when concurrent', async () => {
    saveTokens.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 'added@example.com'
    })
    await Promise.all([
      handleAccountCallback(get(`/accounts/callback?code=a&state=${signState('alice')}`), fakeRes() as never),
      handleAccountCallback(get(`/accounts/callback?code=b&state=${signState('bob')}`), fakeRes() as never)
    ])
    expect(seenSubjects.slice().sort()).toEqual(['alice', 'bob'])
  })

  it('refuses a replayed state and stores nothing the second time', async () => {
    const state = signState('sub-1')
    const first = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=a&state=${state}`), first as never)
    expect(first.status).toBe(200)

    const replay = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=b&state=${state}`), replay as never)
    expect(replay.status).toBe(400)
    expect(saveTokens).toHaveBeenCalledTimes(1)
  })

  it('refuses a replayed state and stores nothing on the replay', async () => {
    const state = signState('victim')
    await handleAccountCallback(get(`/accounts/callback?code=a&state=${state}`), fakeRes() as never)
    expect(saveTokens).toHaveBeenCalledTimes(1)

    saveTokens.mockClear()
    const replay = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=attacker&state=${state}`), replay as never)
    expect(replay.status).toBe(400)
    expect(saveTokens).not.toHaveBeenCalled()
  })

  // Belt to the single-use braces: even on the ordering single-use cannot stop
  // (a stolen state used BEFORE the real user's own callback), the most the
  // holder gets is an extra account -- never the default slot.
  it('cannot promote an account even when the state is used first by someone else', async () => {
    await handleAccountCallback(get(`/accounts/callback?code=stolen&state=${signState('victim')}`), fakeRes() as never)
    expect(saveTokens.mock.calls[0]).toHaveLength(1)
  })

  // A replay must be indistinguishable from a link that was never valid --
  // "already used" would confirm to a prober that they hold a real one.
  it('answers a replay with the same 400 as an unrecognised link', async () => {
    const state = signState('sub-1')
    await handleAccountCallback(get(`/accounts/callback?code=a&state=${state}`), fakeRes() as never)

    const replay = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=b&state=${state}`), replay as never)
    const unknown = fakeRes()
    await handleAccountCallback(get('/accounts/callback?code=b&state=garbage'), unknown as never)

    expect(replay.status).toBe(unknown.status)
    expect(replay.body).toBe(unknown.body)
  })

  it('does not spend the nonce before Google has actually granted anything', async () => {
    // A denied consent must leave the link usable, or a user who clicks "cancel"
    // by mistake is locked out of the flow they just started.
    const state = signState('sub-1')
    await handleAccountCallback(get(`/accounts/callback?error=access_denied&state=${state}`), fakeRes() as never)
    const retry = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=a&state=${state}`), retry as never)
    expect(retry.status).toBe(200)
  })

  // Abandoning a flow and starting a new one is ordinary: the old state stays
  // valid until it expires, and each carries its own nonce, so both complete.
  it('lets an abandoned flow and its restart both complete independently', async () => {
    const abandoned = signState('sub-1')
    const restarted = signState('sub-1')
    const a = fakeRes()
    const b = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=x&state=${restarted}`), a as never)
    await handleAccountCallback(get(`/accounts/callback?code=y&state=${abandoned}`), b as never)
    expect([a.status, b.status]).toEqual([200, 200])
  })

  it('fails closed with 503 when the nonce store is unreachable', async () => {
    process.env.MCP_STORAGE_BACKEND = 'cf-kv'
    process.env.MCP_KV_BASE_URL = 'http://kv.internal'
    resetNonceStoreForTesting()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('kv unreachable')
      })
    )
    try {
      const res = fakeRes()
      await handleAccountCallback(get(`/accounts/callback?code=a&state=${signState('sub-1')}`), res as never)
      expect(res.status).toBe(503)
      expect(saveTokens).not.toHaveBeenCalled()
    } finally {
      delete process.env.MCP_STORAGE_BACKEND
      delete process.env.MCP_KV_BASE_URL
      resetNonceStoreForTesting()
    }
  })

  // A failed write must not wedge the per-subject queue for that user forever.
  it('recovers after a failed write for the same subject', async () => {
    saveTokens.mockRejectedValueOnce(new Error('store exploded'))
    const first = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=a&state=${signState('s')}`), first as never)
    expect(first.status).toBe(500)

    const second = fakeRes()
    await handleAccountCallback(get(`/accounts/callback?code=b&state=${signState('s')}`), second as never)
    expect(second.status).toBe(200)
  })
})
