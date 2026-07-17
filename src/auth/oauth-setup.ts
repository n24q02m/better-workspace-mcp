import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/mcp-core'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME } from '../constants.js'
import { getAuth } from './credential-state.js'
import type { GoogleTokens } from './workspace-auth.js'

// M1: request the full Workspace scope set upfront so Task 7's added domains
// need no re-consent. Keep in sync with the vendored services' API needs.
export const WORKSPACE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/contacts.readonly'
]

// JWT sub = Google stable user id from the id_token; fallback email → 'local-user'.
export function deriveSubject(tokens: Record<string, unknown>): string {
  const idToken = tokens.id_token
  if (typeof idToken === 'string') {
    const payload = idToken.split('.')[1]
    if (payload) {
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
        if (typeof claims.sub === 'string') return claims.sub
        if (typeof claims.email === 'string') return claims.email
      } catch {
        /* fall through */
      }
    }
  }
  return 'local-user'
}

export async function runOAuthSetup(): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET required for OAuth setup.')
  }
  let resolveDone: () => void
  const finished = new Promise<void>((r) => {
    resolveDone = r
  })

  // mcp-core's serverFactory type is McpServer (the high-level SDK wrapper),
  // but runHttpServer only ever calls .connect(transport) on the result --
  // a plain low-level Server satisfies that at runtime. Same cast pattern as
  // better-notion-mcp's transports/http.ts.
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
          tokenEndpointAuthMethod: 'client_secret_post', // Google accepts both; post is simplest
          authorizeParams: { access_type: 'offline', prompt: 'consent' } // Task 0 mcp-core field → refresh_token
        },
        onTokenReceived: async (tokens) => {
          await getAuth().saveTokens(tokens as unknown as GoogleTokens)
          const sub = deriveSubject(tokens as Record<string, unknown>)
          resolveDone()
          return sub
        }
      }
    }
  )
  process.stderr.write(
    `[${SERVER_NAME}] Open http://${handle.host}:${handle.port}/ in a browser to authorize Google.\n`
  )
  await finished
  await handle.close()
}
