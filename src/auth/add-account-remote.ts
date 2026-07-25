/**
 * Add one more Google account to an already-authenticated REMOTE session.
 *
 * The stdio twin (`add-account.ts`) stands a throwaway server on a loopback port
 * and catches Google's redirect there. Remote cannot: the redirect URI of a Web
 * OAuth client must be registered ahead of time, so it is one fixed endpoint
 * inside the already-running server. `extraRoutes` (mcp-core >= 1.22) is what
 * makes owning that endpoint possible.
 *
 * TWO IDENTITIES, never mixed. The `sub` is the PERSON calling -- it comes from
 * the Bearer JWT that authenticated the `config(account_add)` tool call and is
 * carried to the callback in a signed state parameter. The `email` is the Google
 * ACCOUNT being added and comes from the new tokens' `id_token`. Deriving `sub`
 * from the new account's id_token instead would file the account under a bucket
 * keyed by whichever Google identity just consented -- which is the credential
 * isolation failure `deriveSubjectStrict` exists to prevent, arriving by a
 * different road.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRoute } from '@n24q02m/mcp-core'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME } from '../constants.js'
import { getAuth, resolveCredentialState } from './credential-state.js'
import { WORKSPACE_SCOPES } from './oauth-setup.js'
import { runWithSubject } from './subject-context.js'
import type { GoogleTokens } from './workspace-auth.js'

/** Must match a redirect URI registered on the Google **Web** OAuth client. */
export const ACCOUNT_CALLBACK_PATH = '/accounts/callback'

/**
 * How long a started add-account flow stays completable. Long enough to pick an
 * account and type a password, short enough that a state captured from browser
 * history or a Referer header is usually already dead. See the replay note on
 * `verifyState`.
 */
export const STATE_TTL_MS = 10 * 60 * 1000

/**
 * HKDF label separating the state-signing key from every other key derived from
 * CREDENTIAL_SECRET -- in particular mcp-core's JWT signing key.
 *
 * This separation is the point, not a formality. The obvious implementation is
 * to sign the state with `JWTIssuer.issueAccessToken(sub, ttl)`, but that mints
 * a token `verifyAccessToken` accepts: a working Bearer credential for `/mcp` as
 * that subject. A state parameter travels in a URL, through the user's address
 * bar and history, through Google, and back in a `Referer` -- all places a
 * bearer token must never be. So the state is an HMAC under its own derived key:
 * it proves this server started this flow for this subject, and it is useless
 * anywhere else.
 */
const STATE_HKDF_INFO = 'better-workspace/add-account-state/v1'

interface StatePayload {
  /** JWT sub of the user adding an account. */
  sub: string
  /** Absolute expiry, ms since epoch. */
  exp: number
  /** Whether the new account should become primary. Signed so it cannot be flipped. */
  mp?: boolean
  /** Makes each state unique so two flows started in the same millisecond differ. */
  n: string
}

function stateKey(): Buffer {
  const secret = process.env.CREDENTIAL_SECRET
  if (!secret) {
    throw new Error('CREDENTIAL_SECRET is required to sign the add-account state.')
  }
  // Empty salt: the secret is already high-entropy and every replica must derive
  // the SAME key, so there is nothing per-instance to salt with. The domain
  // separation lives in `info`.
  return Buffer.from(hkdfSync('sha256', secret, '', STATE_HKDF_INFO, 32))
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url')
}

export function signState(sub: string, opts: { makePrimary?: boolean; now?: number } = {}): string {
  const payload: StatePayload = {
    sub,
    exp: (opts.now ?? Date.now()) + STATE_TTL_MS,
    n: randomBytes(9).toString('base64url')
  }
  if (opts.makePrimary) payload.mp = true
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${sign(body)}`
}

/**
 * Recover the payload of a state this server signed, or `null` for anything else
 * -- tampered, forged, expired, or malformed.
 *
 * Returning `null` rather than throwing per failure reason is deliberate: the
 * caller renders one 400 for all of them, so a probing client cannot tell a bad
 * signature from an expired one.
 *
 * Known residual: a state is replayable until it expires. Making it single-use
 * needs server-side state that survives a cold start (KV), which this flow
 * otherwise does not need at all. The exposure is narrow -- an attacker also has
 * to complete a Google consent of their own within the window, and what they
 * achieve is attaching THEIR account to the victim's bucket, not reading it.
 */
export function verifyState(state: string, now: number = Date.now()): StatePayload | null {
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const body = state.slice(0, dot)
  const mac = state.slice(dot + 1)

  const expected = Buffer.from(sign(body), 'utf8')
  const given = Buffer.from(mac, 'utf8')
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first -- length is not a secret, the bytes are.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null
    return payload
  } catch {
    return null
  }
}

function redirectUri(): string {
  const publicUrl = process.env.PUBLIC_URL
  if (!publicUrl) {
    throw new Error(
      'PUBLIC_URL is required to add an account remotely: it is the redirect URI Google sends the consent back to, and it must match a URI registered on the Web OAuth client.'
    )
  }
  // Trailing slashes stripped the same way mcp-core's getBaseUrl does, so
  // PUBLIC_URL="https://host/" and "https://host" produce the same redirect URI
  // -- Google compares it as an exact string.
  return `${publicUrl.replace(/\/+$/, '')}${ACCOUNT_CALLBACK_PATH}`
}

/**
 * Google consent URL for adding an account to `sub`'s bucket.
 *
 * Not async: everything here is local. Callers may still `await` it.
 */
export function buildAddAccountUrl(sub: string, opts: { makePrimary?: boolean } = {}): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is required to add an account.')
  }
  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', WORKSPACE_SCOPES.join(' '))
  // Both are required for Google to return a refresh_token: without
  // access_type=offline there is none, and without prompt=consent a user who
  // already granted these scopes gets an access token only. A stored account
  // with no refresh_token dies at the first expiry.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', signState(sub, opts))
  return url.toString()
}

async function exchangeCode(code: string): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET required to exchange the consent code.')
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // client_secret_post, matching the delegated flow in transports/http.ts.
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    })
  })
  if (!res.ok) {
    // Google's error body is short and does not echo the request, so it is safe
    // to surface -- truncated anyway so an unexpected page cannot flood the log.
    throw new Error(`Google rejected the consent code: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as GoogleTokens
}

/**
 * Serialises credential writes per subject.
 *
 * `AccountStore.put` is read-modify-write over ONE encrypted blob, and the store
 * writes it with write-then-rename. Two consents for the same user landing
 * together -- a reloaded consent page, a double-clicked link, or a flow the user
 * abandoned and restarted -- would interleave into a lost account or an ENOENT
 * from the rename racing itself. stdio avoids this by holding the single
 * in-flight consent per flow (`add-account.ts`); remote has no flow object to
 * hang that on, because every callback is an independent HTTP request, so the
 * serialisation is keyed by subject instead.
 *
 * In-process only, which is sufficient here and not by luck: `worker.ts`
 * collapses every request onto one Durable Object under `max_instances: 1`, so
 * there is exactly one process. A future multi-container deploy would need this
 * moved into the store as a real lock.
 */
const pendingBySubject = new Map<string, Promise<unknown>>()

function serializeBySubject<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  const prior = pendingBySubject.get(sub) ?? Promise.resolve()
  // Chained off BOTH outcomes: a failed write must not wedge the queue.
  const run = prior.then(fn, fn)
  const guard = run.then(
    () => undefined,
    () => undefined
  )
  pendingBySubject.set(sub, guard)
  void guard.then(() => {
    // Only the tail clears itself, so a later write queued behind this one is
    // not dropped from the map while still pending.
    if (pendingBySubject.get(sub) === guard) pendingBySubject.delete(sub)
  })
  return run
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function respond(res: ServerResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

export async function handleAccountCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Host is irrelevant here -- only the query is read -- so any base works.
  const query = new URL(req.url ?? '', 'http://localhost').searchParams

  // The state IS the gate. mcp-core gates /authorize behind the relay password
  // but knows nothing about routes a consumer registers, so this route
  // authenticates itself: no state this server signed, nothing happens and
  // nothing is rendered beyond a flat 400.
  const state = query.get('state')
  const payload = state ? verifyState(state) : null
  if (!payload) {
    respond(
      res,
      400,
      'Link expired or not recognised',
      'Start again with config(action="account_add") and open the fresh link. A link is only valid for a few minutes.'
    )
    return
  }

  // Checked AFTER the state so an unauthenticated caller cannot tell a real
  // consent error apart from a rejected link.
  const error = query.get('error')
  if (error) {
    respond(res, 400, 'Google did not grant access', `Google returned "${error}". No account was added.`)
    return
  }

  const code = query.get('code')
  if (!code) {
    respond(res, 400, 'Incomplete consent', 'Google did not return an authorization code. No account was added.')
    return
  }

  try {
    const tokens = await exchangeCode(code)
    const email = await serializeBySubject(payload.sub, () =>
      // getAuth() reads the subject context, so the write MUST happen inside
      // this scope -- outside it the account would land in the stdio bucket.
      runWithSubject(payload.sub, async () => {
        const stored = await getAuth().saveTokens(tokens, { makePrimary: payload.mp })
        // This bucket now definitely has an account; refresh its own state so the
        // caller's next domain tool call is not gated on a stale 'awaiting_setup'.
        await resolveCredentialState()
        return stored
      })
    )
    respond(res, 200, 'Account added', `${email} is now connected. You can close this tab.`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${SERVER_NAME}] add-account callback failed:`, message)
    respond(res, 500, 'Could not add the account', message)
  }
}

export function accountCallbackRoute(): HttpRoute {
  return { method: 'GET', path: ACCOUNT_CALLBACK_PATH, handler: handleAccountCallback }
}
