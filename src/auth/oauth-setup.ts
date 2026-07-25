import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/mcp-core'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME } from '../constants.js'
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

export async function runOAuthSetup(): Promise<void> {
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
          try {
            await getAuth().saveTokens(tokens as unknown as GoogleTokens)
            const sub = deriveSubject(tokens as Record<string, unknown>)
            resolveDone()
            return sub
          } catch (err) {
            rejectDone(err)
            throw err // let mcp-core also surface its 500 to the browser
          }
        }
      }
    }
  )
  process.stderr.write(
    `[${SERVER_NAME}] Open http://${handle.host}:${handle.port}/ in a browser to authorize Google.\n`
  )
  try {
    await finished
  } finally {
    await handle.close()
  }
}
