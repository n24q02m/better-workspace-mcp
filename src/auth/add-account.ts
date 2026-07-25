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
  /** Resolves with the email that was added; rejects if the flow failed. */
  done: Promise<string>
}

export async function startAddAccount(opts: { makePrimary?: boolean } = {}): Promise<AddAccountFlow> {
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

  const done = settled.finally(() => handle.close())
  return { url: `http://${handle.host}:${handle.port}/`, done }
}
