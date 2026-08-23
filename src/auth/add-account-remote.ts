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
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRoute } from '@n24q02m/mcp-core'
import { type SessionKv, wrapKvBackendAsSessionKv } from '@n24q02m/mcp-core/auth'
import { backendFromEnv } from '@n24q02m/mcp-core/storage'
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

/**
 * There is deliberately NO make-primary flag here.
 *
 * Signing one would have been safe from tampering but not from use: whoever
 * presents the state -- by replaying it, or simply by racing the real user to it
 * -- would promote THEIR Google account to the caller's default, and every later
 * tool call that omits `account=` (the path most calls take) would run against
 * the attacker's Drive, Gmail and Docs. Single-use narrows that but cannot close
 * the racing case (see `claimNonce`), so the privilege itself was removed from
 * the browser round-trip instead. Changing the default is `account_set_default`,
 * which travels inside an authenticated MCP call and never leaves the session.
 *
 * stdio keeps its `makePrimary`: nothing there crosses a URL, there is no `sub`
 * to impersonate, and it is one user on their own machine.
 */
interface StatePayload {
  /** JWT sub of the user adding an account. */
  sub: string
  /** Absolute expiry, ms since epoch. */
  exp: number
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

export function signState(sub: string, opts: { now?: number } = {}): string {
  const payload: StatePayload = {
    sub,
    exp: (opts.now ?? Date.now()) + STATE_TTL_MS,
    n: randomBytes(9).toString('base64url')
  }
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
 * A valid signature is NOT sufficient on its own -- the callback additionally
 * claims the nonce, which makes a state single-use under the consistency limits
 * spelled out on `claimNonce`. Read those before treating it as a hard lock.
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

/**
 * KV namespace for spent state nonces.
 *
 * MUST stay under the `better-workspace/` prefix that `src/worker.ts` allowlists
 * on the container's `kv.internal` outbound handler -- a key outside it is
 * rejected with a 403 that surfaces nowhere.
 */
const NONCE_KV_PREFIX = 'better-workspace/add-account-nonce:'

/**
 * In-process fallback used when there is no durable KV (http mode outside the
 * cf-kv deploy), mirroring what mcp-core's own session store does in that case.
 * Single-use is then only guaranteed WITHIN one process -- which is complete for
 * a single-process deploy and would not be for a multi-replica one.
 */
const localNonces = new Map<string, number>()

let cachedNonceKv: SessionKv | undefined
let cachedNonceKvFor: string | undefined

function nonceKv(): SessionKv {
  const backendKind = (process.env.MCP_STORAGE_BACKEND ?? '').toLowerCase()
  if (backendKind !== 'cf-kv') {
    return {
      get: async (key) => {
        const exp = localNonces.get(key)
        if (exp === undefined) return null
        if (exp <= Date.now()) {
          localNonces.delete(key)
          return null
        }
        return String(exp)
      },
      put: async (key, value) => void localNonces.set(key, Number(value)),
      delete: async (key) => void localNonces.delete(key)
    }
  }
  // Rebuilt if the backend changes under us (tests), otherwise reused.
  if (!cachedNonceKv || cachedNonceKvFor !== backendKind) {
    cachedNonceKv = wrapKvBackendAsSessionKv(backendFromEnv(), NONCE_KV_PREFIX)
    cachedNonceKvFor = backendKind
  }
  return cachedNonceKv
}

/** Test seam: drop the memoised KV and any in-process nonces. */
export function resetNonceStoreForTesting(): void {
  cachedNonceKv = undefined
  cachedNonceKvFor = undefined
  localNonces.clear()
}

/**
 * Spend a state's nonce, returning false if it was already spent.
 *
 * What a usable state is worth to someone who is not its owner: they can add a
 * Google account of their choosing to that subject's bucket. Nothing already in
 * the bucket is read, and the default account cannot be moved -- the state
 * carries no privilege to move it (see `StatePayload`), so an untargeted tool
 * call still runs against whatever the owner had set. So the ceiling is an
 * unwanted account appearing in `account_list`.
 *
 * (Historical: the state once carried a signed `mp` make-primary flag, which
 * raised that ceiling to taking over the default account. It was removed rather
 * than defended, because single-use cannot cover the racing order in (2) below.)
 *
 * `SessionKv` has no TTL and no compare-and-set, so expiry is stored in the
 * value and the read-then-write is made atomic by the caller: this runs inside
 * `serializeBySubject`, and a replay is BY DEFINITION the same state and
 * therefore the same subject, so it queues behind the original rather than
 * racing it. That holds within ONE process and is exactly as strong as that
 * assumption -- see the note on the in-process fallback above.
 *
 * A KV failure propagates instead of being swallowed. Failing open here would
 * restore exactly the replay window this exists to close, and add-account is a
 * rare, retryable operation -- refusing it during a KV outage is the cheap side
 * of that trade.
 *
 * THIS IS A BARRIER, NOT A LOCK. Do not read more into it than it gives:
 *
 * 1. Cloudflare KV is eventually consistent. Its own docs say a write is
 *    "usually immediately visible" at the location that made it, then add:
 *    "However, this is not guaranteed and therefore it is not advised to rely
 *    on this behaviour." Sharper for this exact pattern, KV caches NEGATIVE
 *    lookups as well as positive ones -- so the `get` below is itself what
 *    plants a "this key is missing" entry, and a replay arriving before that
 *    entry times out can read the stale miss and pass. The practical window
 *    shrinks from the state's full ten minutes to something usually sub-second,
 *    which is a large improvement and still not a guarantee.
 *
 * 2. It does nothing about an attacker who presents a stolen state BEFORE the
 *    legitimate user does. That is a race, not a replay, and no amount of
 *    storage strength changes it. What single-use buys there is DETECTION: the
 *    real user's own link then fails, so the theft surfaces instead of both
 *    consents quietly succeeding.
 *
 * Durable Object storage is strongly consistent and would close (1). It is
 * deliberately not used: it needs a second DO class, binding and migration, and
 * it would tighten a seconds-wide window while leaving (2) -- the likelier
 * ordering -- exactly as it is. Harm was capped at the `StatePayload` end
 * instead, which covers both orderings; this barrier sits on top of that cap,
 * not in place of it.
 */
export async function claimNonce(nonce: string, exp: number, now: number = Date.now()): Promise<boolean> {
  const kv = nonceKv()
  const seen = await kv.get(nonce)
  // A spent marker past its own expiry is indistinguishable from absent: the
  // state it belonged to is dead anyway, so the entry is free to be overwritten
  // rather than accumulating forever in a store with no TTL of its own.
  if (seen !== null && Number(seen) > now) return false
  await kv.put(nonce, String(exp))
  return true
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
export function buildAddAccountUrl(sub: string): string {
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
  url.searchParams.set('state', signState(sub))
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

function formatDetail(detail: string): string {
  return escapeHtml(detail).replace(/`([^`]+)`/g, '<code>$1</code>')
}

const CALLBACK_CSS =
  'body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5;text-align:center}main{display:flex;flex-direction:column;align-items:center}.main-content{display:flex;flex-direction:column;align-items:center}.feedback-icon{width:3rem;height:3rem;margin-bottom:1rem}.feedback-icon--success{color:#10b981}.feedback-icon--error{color:#ef4444}h1{margin-top:0}code{background:#f3f4f6;padding:0.2rem 0.4rem;border-radius:0.25rem;font-family:monospace}@media(prefers-color-scheme:dark){code{background:#374151;color:#e5e7eb}}'
const CALLBACK_STYLE_HASH = createHash('sha256').update(CALLBACK_CSS).digest('base64')

function respond(res: ServerResponse, status: number, title: string, detail: string): void {
  const iconClass = status === 200 ? 'feedback-icon--success' : 'feedback-icon--error'
  const role = status === 200 ? 'status' : 'alert'
  const icon =
    status === 200
      ? `<svg aria-hidden="true" class="feedback-icon ${iconClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`
      : `<svg aria-hidden="true" class="feedback-icon ${iconClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${CALLBACK_CSS}</style><body><main><div role="${role}" class="main-content">${icon}<h1>${escapeHtml(title)}</h1><p>${formatDetail(detail)}</p></div></main></body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${CALLBACK_STYLE_HASH}'`,
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cache-Control': 'no-store'
  })
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
      'Start again with `config(action="account_add")` and open the fresh link. A link is only valid for a few minutes.'
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

  // Spend the state. Inside the per-subject queue so the read-then-write is
  // atomic against a concurrent replay (same state => same subject => queued).
  // A replay gets the SAME 400 as an unrecognised link: telling a caller that
  // their link was "already used" confirms they hold a real one.
  let claimed: boolean
  try {
    claimed = await serializeBySubject(payload.sub, () => claimNonce(payload.n, payload.exp))
  } catch (err) {
    // KV unreachable. Fail closed -- see claimNonce.
    console.error(`[${SERVER_NAME}] could not check the add-account link:`, err)
    respond(
      res,
      503,
      'Could not verify the link',
      'The server could not reach its state store, so it refused the request rather than risk accepting a reused link. Try again shortly.'
    )
    return
  }
  if (!claimed) {
    respond(
      res,
      400,
      'Link expired or not recognised',
      'Start again with `config(action="account_add")` and open the fresh link. A link is only valid for a few minutes.'
    )
    return
  }

  try {
    const tokens = await exchangeCode(code)
    const email = await serializeBySubject(payload.sub, () =>
      // getAuth() reads the subject context, so the write MUST happen inside
      // this scope -- outside it the account would land in the stdio bucket.
      runWithSubject(payload.sub, async () => {
        // No makePrimary -- see StatePayload. AccountStore still promotes an
        // account entering an EMPTY bucket, because a bucket holding accounts
        // with no working primary would be broken; that is the store's
        // invariant, not a privilege this flow can be asked to grant.
        const stored = await getAuth().saveTokens(tokens)
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
    // The nonce stays spent even though nothing was stored. Releasing it would
    // let the same state be presented again with a DIFFERENT Google code, which
    // is the replay this just blocked. Google's own code is single-use anyway,
    // so the link was dead the moment it was submitted -- a fresh one is the
    // only correct recovery, and the message says so.
    // [SECURITY] Do not leak internal error details to client in 500 response
    respond(
      res,
      500,
      'Could not add the account',
      'An internal error occurred. Start again with `config(action="account_add")`.'
    )
  }
}

export function accountCallbackRoute(): HttpRoute {
  return { method: 'GET', path: ACCOUNT_CALLBACK_PATH, handler: handleAccountCallback }
}
