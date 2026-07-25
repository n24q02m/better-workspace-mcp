/**
 * Add one more Google account to a running (stdio) server.
 *
 * Reuses oauth-setup.ts's one-shot pattern: stand a temporary HTTP server up on
 * 127.0.0.1:0 to catch Google's redirect, wait for the token, then close. It
 * differs from runOAuthSetup() in that this returns the URL IMMEDIATELY so a
 * tool call can hand it to the user -- the waiting lives in the `done` promise.
 *
 * This is the STDIO path only. Remote has its own (`add-account-remote.ts`): a
 * Web OAuth client's redirect URI must be registered ahead of time, so it cannot
 * be a loopback port picked at runtime, and the callback has to live at a fixed
 * path inside the already-running server -- which `extraRoutes` (mcp-core >=
 * 1.22) makes possible. `config(action="account_add")` picks between the two on
 * `currentSubject()`.
 *
 * `makePrimary` stays available HERE and deliberately not there: nothing in this
 * flow crosses a URL, so there is no token a third party could present to
 * promote an account of their own. Remote callers use `account_set_default`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/mcp-core'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME } from '../constants.js'
import { emailFromIdToken } from './account-store.js'
import { closeAfterGrace, closeNow } from './consent-server.js'
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

  /**
   * The one consent allowed to write, held as the in-flight promise rather than a flag
   * set after its `await`. Two tabs redirecting at once -- the very case the grace window
   * below exists for -- would both find a flag still unset, and two concurrent
   * `saveTokens` calls race the credential store's write-then-rename into an ENOENT.
   */
  let firstConsent: Promise<string> | null = null

  // Same McpServer cast as oauth-setup.ts: runHttpServer only ever calls
  // .connect(transport) on the factory result, which a low-level Server satisfies.
  const handle = await runHttpServer(
    () => new Server({ name: SERVER_NAME, version: '0.0.0' }, { capabilities: {} }) as unknown as McpServer,
    {
      serverName: SERVER_NAME,
      // This function hands the URL back to the caller, which surfaces it in the
      // tool result -- so mcp-core opening a tab of its own would be a SECOND
      // entry point into the same temporary server, and the user would start two
      // consent flows without knowing it. Note this removes one source of extra
      // tabs, not the need for the grace window below: the user clicking the
      // returned link twice, or reloading the finished page, still produces late
      // redirects that must land somewhere alive (consent-server.ts).
      openBrowser: false,
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
          // One flow adds ONE account. Every consent tab that comes back lands here (see
          // CLOSE_GRACE_MS), so the first one writes and the rest are checked against it --
          // otherwise a second tab where the user picked a different identity in Google's
          // account chooser would be stored silently, and with makePrimary it would take
          // primary away from the account this flow already reported adding.
          if (firstConsent === null) {
            firstConsent = getAuth()
              .saveTokens(tokens as unknown as GoogleTokens, { makePrimary: opts.makePrimary })
              .then(
                (email) => {
                  resolveDone(email)
                  return email
                },
                (err) => {
                  rejectDone(err)
                  throw err // let mcp-core surface the failure on the consent page too
                }
              )
            return firstConsent
          }

          // Whatever the first tab settled on -- rejecting here if it failed, which is
          // right: the flow is over either way, and a late tab must not revive it.
          const added = await firstConsent
          if (emailFromIdToken((tokens as unknown as GoogleTokens).id_token) === added) {
            // Same account twice: nothing left to write, and re-running makePrimary would
            // be a second write for a primary that is already set to this very account.
            return added
          }
          // Also the no-email-claim case, where the account cannot be shown to be the same
          // one -- refusing costs the user one more account_add call, storing the wrong
          // account costs them a mailbox they never meant to connect.
          throw new Error(
            `This add-account flow already completed for ${added}. Call config(action="account_add") again to add a different account.`
          )
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

  // race, NOT any: whichever settles first wins, so a real onTokenReceived failure
  // surfaces now. Promise.any ignores rejections, which would hide that error behind a
  // "timed out" ten minutes later.
  const done = Promise.race([settled, timeout])

  // Shut down on our own schedule instead of through .finally() on `done`: the caller's
  // promise has to settle the moment consent lands -- it is what the tool call reports --
  // while the port outlives it by the grace window. Attached once, here, so the server
  // closes once however many places end up awaiting `done`. Why the window exists at all:
  // consent-server.ts.
  done.then(
    () => {
      clearTimeout(timer)
      closeAfterGrace(handle, opts.graceMs)
    },
    () => {
      clearTimeout(timer)
      closeNow(handle)
    }
  )
  return { url: `http://${handle.host}:${handle.port}/`, done }
}
