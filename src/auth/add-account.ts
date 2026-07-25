/**
 * Add one more Google account to a running (stdio) server.
 *
 * Reuses oauth-setup.ts's one-shot pattern: stand a temporary HTTP server up on
 * 127.0.0.1:0 to catch Google's redirect, wait for the token, then close. It
 * differs from runOAuthSetup() in that this returns the URL IMMEDIATELY so a
 * tool call can hand it to the user -- the waiting lives in the `done` promise.
 *
 * Remote HTTP (M3) cannot use this path: there it needs a fixed callback endpoint
 * inside the already-running server, and runHttpServer has no way to add a route
 * (RunHttpServerOptions exposes no hook, auth/router.ts is not exported) -- see
 * correction 2 in the M2 plan.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/mcp-core'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME } from '../constants.js'
import { getAuth } from './credential-state.js'
import { WORKSPACE_SCOPES } from './oauth-setup.js'
import type { GoogleTokens } from './workspace-auth.js'

export interface AddAccountFlow {
  /** URL the user opens to start the consent screen. */
  url: string
  /** Resolves with the email that was added; rejects if the flow failed or timed out. */
  done: Promise<string>
}

/**
 * Walking away mid-consent is ordinary, and unlike runOAuthSetup() -- which blocks
 * until the flow ends, so an abandoned one is visible as a stuck process -- this
 * function returns immediately and the waiting is invisible. Without a deadline the
 * temporary server would then stay up holding its port forever, one leak per
 * abandoned call. After this long the flow closes itself.
 */
const FLOW_TTL_MS = 10 * 60 * 1000

/**
 * How long the temporary server outlives a SUCCESSFUL consent.
 *
 * A second consent tab is ordinary -- the user clicks the URL twice, the browser
 * prefetches it, they reload the finished page, or another tool opens its own. Each tab
 * runs its own PKCE handshake and comes back to `/callback` with its own code (mcp-core
 * keys pending sessions on a per-tab nonce, so the late one is still valid), which means
 * closing the server the instant the FIRST tab succeeds drops the second onto a dead
 * port. Seen in the field: one tab showing "Setup complete", the other
 * ERR_CONNECTION_REFUSED at 127.0.0.1:<port>/callback -- an error page for a consent
 * that actually worked.
 *
 * Staying up this much longer gives a late tab somewhere to land; a second code for the
 * same account just rewrites that account's record, so it is idempotent.
 */
const CLOSE_GRACE_MS = 10_000

export async function startAddAccount(
  opts: { makePrimary?: boolean; ttlMs?: number; graceMs?: number } = {}
): Promise<AddAccountFlow> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET required to add an account.')
  }

  let resolveDone: (email: string) => void
  let rejectDone: (err: unknown) => void
  const settled = new Promise<string>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })

  // Same McpServer cast as oauth-setup.ts: runHttpServer only ever calls
  // .connect(transport) on the factory result, which a low-level Server satisfies.
  const handle = await runHttpServer(
    () => new Server({ name: SERVER_NAME, version: '0.0.0' }, { capabilities: {} }) as unknown as McpServer,
    {
      serverName: SERVER_NAME,
      delegatedOAuth: {
        flow: 'redirect',
        upstream: {
          authorizeUrl: GOOGLE_AUTHORIZE_URL,
          tokenUrl: GOOGLE_TOKEN_URL,
          clientId,
          clientSecret,
          scopes: WORKSPACE_SCOPES,
          tokenEndpointAuthMethod: 'client_secret_post',
          authorizeParams: { access_type: 'offline', prompt: 'consent' }
        },
        onTokenReceived: async (tokens) => {
          try {
            const email = await getAuth().saveTokens(tokens as unknown as GoogleTokens, {
              makePrimary: opts.makePrimary
            })
            resolveDone(email)
            return email
          } catch (err) {
            rejectDone(err)
            throw err // let mcp-core surface the failure on the consent page too
          }
        }
      }
    }
  )

  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error('Add-account flow timed out before the Google consent completed.')),
      opts.ttlMs ?? FLOW_TTL_MS
    )
    // Don't let the deadline alone keep the event loop alive -- on a stdio server that
    // turns exiting into a ten-minute hang.
    if (typeof timer.unref === 'function') timer.unref()
  })

  // A close failure is nobody's outcome by the time it happens -- the consent has
  // already been saved, or already failed on its own -- and this runs on a promise no
  // caller holds. So say it on stderr rather than raising it into `done` (which would
  // report a working consent as a failed one) or dropping it into an unhandled rejection.
  const closeServer = (): void => {
    void handle.close().catch((err) => {
      console.error(`[${SERVER_NAME}] failed to close the add-account callback server:`, err)
    })
  }

  // race, NOT any: whichever settles first wins, so a real onTokenReceived failure
  // surfaces now. Promise.any ignores rejections, which would hide that error behind a
  // "timed out" ten minutes later.
  const done = Promise.race([settled, timeout])

  // Shut down on our own schedule instead of through .finally() on `done`: the caller's
  // promise has to settle the moment consent lands -- it is what the tool call reports --
  // while the port outlives it by CLOSE_GRACE_MS. Attached once, here, so the server
  // closes once however many places end up awaiting `done`.
  done.then(
    () => {
      clearTimeout(timer)
      const graceTimer = setTimeout(closeServer, opts.graceMs ?? CLOSE_GRACE_MS)
      // Same reason as the deadline above: a pending close must not hold the process open.
      if (typeof graceTimer.unref === 'function') graceTimer.unref()
    },
    () => {
      // Timed out, or the tokens could not be stored: nobody is mid-consent, so there is
      // no late tab worth keeping the port alive for.
      clearTimeout(timer)
      closeServer()
    }
  )
  return { url: `http://${handle.host}:${handle.port}/`, done }
}
