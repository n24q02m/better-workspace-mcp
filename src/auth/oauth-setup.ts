import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/mcp-core'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME } from '../constants.js'
import { emailFromIdToken } from './account-store.js'
import { closeAfterGrace, closeNow } from './consent-server.js'
import { getAuth } from './credential-state.js'
import type { GoogleTokens } from './workspace-auth.js'

// M1 aimed to request the full Workspace scope set upfront so domains added
// later need no re-consent. The Forms set (M4) was missed then and is added
// here in M2, so the next real consent -- adding a second account -- covers it
// too, instead of making the user click through another round at M4. Keep in
// sync with the APIs the vendored services actually call.
//
// Note for M4: Google does not widen an already-issued token, so an account
// authorized BEFORE this change keeps the old scope set and will need a
// re-consent once Forms is called. Accounts added after it will not.
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
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly'
]

/** Bucket của stdio khi không suy được danh tính. Chỉ `deriveSubject` dùng. */
const LOCAL_USER = 'local-user'

/**
 * Danh tính suy được từ `id_token` của Google: `sub` (stable user id), rồi
 * `email`. `undefined` = không suy được (không có id_token, payload rác, hoặc
 * payload không mang claim nào dùng được).
 */
function subjectFromIdToken(tokens: Record<string, unknown>): string | undefined {
  const idToken = tokens.id_token
  if (typeof idToken !== 'string') return undefined
  const payload = idToken.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof claims.sub === 'string' && claims.sub) return claims.sub
    if (typeof claims.email === 'string' && claims.email) return claims.email
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Tên bucket cho chế độ STDIO. Không suy được danh tính thì trả `'local-user'`
 * -- vô hại ở đây vì stdio chỉ có một người dùng và một bucket.
 *
 * KHÔNG dùng ở chế độ remote: ở đó mọi người dùng không suy được danh tính sẽ
 * dồn vào cùng bucket `'local-user'`, tức chung credential mà không có tín hiệu
 * nào. Remote dùng `deriveSubjectStrict`.
 */
export function deriveSubject(tokens: Record<string, unknown>): string {
  return subjectFromIdToken(tokens) ?? LOCAL_USER
}

/**
 * Danh tính cho chế độ REMOTE. Ném khi không suy được, không bao giờ trả một
 * sentinel dùng chung: mcp-dev invariant 7 yêu cầu mọi bucket credential ở remote
 * phải keyed theo subject thật, và một fallback ở đây là silent fallback vào blob
 * dùng chung -- chỉ nằm ở đường GHI thay vì đường đọc.
 *
 * Đường bình thường không tới lượt nhánh ném: `WORKSPACE_SCOPES` xin `openid` +
 * `email` nên Google luôn trả `id_token` có `sub`. Nhưng "nhà cung cấp chắc sẽ
 * trả đúng" không phải cách bảo vệ một ranh giới cách ly credential -- parse
 * fail, provider đổi hành vi, hay một `id_token` bị cắt là đủ.
 *
 * Caller KHÔNG được so kết quả với chuỗi `'local-user'` để tự phát hiện fallback:
 * so sánh sentinel là cái bẫy cho người sửa sau. Gọi đúng hàm cho đúng chế độ.
 */
export function deriveSubjectStrict(tokens: Record<string, unknown>): string {
  const subject = subjectFromIdToken(tokens)
  if (!subject) {
    throw new Error(
      'Cannot isolate credentials for this session: the Google token response carried no usable identity (no `sub` or `email` claim in the id_token). Nothing was stored.'
    )
  }
  return subject
}

export async function runOAuthSetup(opts: { graceMs?: number } = {}): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET required for OAuth setup.')
  }
  let resolveDone: () => void
  let rejectDone: (err: unknown) => void
  const finished = new Promise<void>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })

  /**
   * The one consent allowed to write, resolving with the email it stored. Held as the
   * in-flight promise, not a flag set after its `await`: two tabs arriving at once would
   * both find a flag still unset, and two concurrent `saveTokens` calls race the credential
   * store's write-then-rename into an ENOENT. Same rule as startAddAccount, and it bites
   * harder here -- see the stderr line below for why this path has two tab sources.
   */
  let firstConsent: Promise<string> | null = null

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
          if (firstConsent === null) {
            firstConsent = getAuth()
              .saveTokens(tokens as unknown as GoogleTokens)
              .then(
                (email) => {
                  resolveDone()
                  return email
                },
                (err) => {
                  rejectDone(err)
                  throw err // let mcp-core also surface its 500 to the browser
                }
              )
            await firstConsent
            return deriveSubject(tokens as Record<string, unknown>)
          }

          // A later tab. Rejecting here if the first one failed is right: setup is over
          // either way, and a late tab must not revive a flow whose server is closing.
          const setUpAs = await firstConsent
          if (emailFromIdToken((tokens as unknown as GoogleTokens).id_token) === setUpAs) {
            // Same account twice -- nothing left to store, so this tab just gets its page.
            return deriveSubject(tokens as Record<string, unknown>)
          }
          // Also the no-email-claim case, where this tab cannot be shown to be the same
          // account. Refusing costs one more consent; storing it connects a mailbox the
          // user never chose to set the server up with.
          throw new Error(
            `Setup already completed for ${setUpAs}. Use config(action="account_add") to add another account.`
          )
        }
      }
    }
  )
  // mcp-core opens this URL itself whenever the stored config is incomplete, which is
  // always true here -- this flow only runs with no credentials. So the line below is a
  // FALLBACK, not an instruction: worded as one ("Open <url> to authorize") it asks the user
  // to start a second consent against the tab already on their screen, and until the grace
  // window existed the slower of the two tabs got ERR_CONNECTION_REFUSED. The env vars are
  // mcp-core's own auto-open switch (tryOpenBrowser returns false on either), checked so
  // this does not promise a tab that will never appear.
  const url = `http://${handle.host}:${handle.port}/`
  const autoOpens = !process.env.MCP_NO_BROWSER && !process.env.NO_BROWSER
  process.stderr.write(
    autoOpens
      ? `[${SERVER_NAME}] Waiting for Google authorization -- a browser tab should have opened at ${url}. Go there yourself only if it did not.\n`
      : `[${SERVER_NAME}] Waiting for Google authorization -- auto-open is off, so go to ${url} in a browser.\n`
  )
  try {
    await finished
  } catch (err) {
    // Nobody is mid-consent on a failure, so there is no late tab worth the port.
    closeNow(handle)
    throw err
  }
  // Hand startup back NOW and let the port linger: boot must not wait out the grace window
  // (see consent-server.ts), while a late consent tab still needs somewhere to land.
  closeAfterGrace(handle, opts.graceMs)
}
