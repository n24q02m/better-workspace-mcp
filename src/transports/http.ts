/**
 * HTTP transport -- remote OAuth 2.1 delegated tới Google, multi-user theo JWT sub.
 *
 * Session-based (không stateless): SDK 1.29.0 chưa implement spec 2026-07-28, và
 * mcp-core đã thử stateless rồi phải revert (`transport/local-server.ts` phần
 * per-session pattern: SDK trả HTTP 500 ở `notifications/initialized` vì mỗi
 * request rơi vào một transport mới với `_initialized=false`). Migrate khi SDK hỗ trợ.
 *
 * Hai trục cách ly xếp lồng nhau, KHÔNG gộp: `subjectContext` (người dùng nào,
 * từ Bearer JWT) bọc ngoài `accountContext` của M2 (Google account nào của người
 * đó, từ tham số tool). authScope mở lớp ngoài; `makeDomainRun` mở lớp trong.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/mcp-core'
import { type SessionKv, wrapKvBackendAsSessionKv } from '@n24q02m/mcp-core/auth'
import { backendFromEnv } from '@n24q02m/mcp-core/storage'
import { getAuth, resolveCredentialState } from '../auth/credential-state.js'
import { deriveSubject, WORKSPACE_SCOPES } from '../auth/oauth-setup.js'
import { runWithSubject } from '../auth/subject-context.js'
import type { GoogleTokens } from '../auth/workspace-auth.js'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, SERVER_NAME, STORE_PLUGIN } from '../constants.js'
import { registerTools } from '../tools/registry.js'

/**
 * Bucket của caller anonymous. mcp-core CHỈ cấp claims anonymous khi
 * `authDisabled` được bật, thứ transport này không bao giờ bật (xem chỗ gọi
 * `runHttpServer`) -- nên nhánh này thực tế không tới lượt chạy. Giữ nó để câu
 * trả lời cho "anonymous thì vào đâu" là một bucket riêng có tên, chứ không phải
 * bucket của một người dùng thật nào đó.
 */
const ANONYMOUS_BUCKET = 'default'

/**
 * KV durable cho state handshake của delegated OAuth (pending session + auth
 * code), để nó sống qua cold-start giữa /authorize và /callback. Prefix phải
 * app-scoped: outbound handler `kv.internal` của Worker allowlist key theo đúng
 * prefix này, prefix khác bị 403 và không có thông báo. Ngoài deploy cf-kv trả
 * undefined -> session store dùng map in-process, đúng cho single-process.
 */
export function sessionKvForDeploy(): SessionKv | undefined {
  if ((process.env.MCP_STORAGE_BACKEND ?? '').toLowerCase() !== 'cf-kv') return undefined
  return wrapKvBackendAsSessionKv(backendFromEnv(), `${STORE_PLUGIN}/delegated-oauth:`)
}

/**
 * Sub đã warm state trong process này. Warm-up đọc + giải mã blob của bucket
 * (scrypt), nên chạy mỗi request là phí trên đường nóng; một lần cho mỗi sub cho
 * mỗi vòng đời container là đủ, vì sau đó `resolveCredentialState` /
 * `resetState` tự cập nhật map state.
 */
const warmedSubjects = new Set<string>()

/**
 * Nạp credential state cho `sub` nếu chưa nạp trong process này.
 *
 * Cần thiết vì map state của `credential-state.ts` nằm trong RAM: sau khi
 * container bị recreate nó rỗng, trong khi credential vẫn còn trong store. Không
 * warm lại thì `registry.ts` thấy 'awaiting_setup' và chặn mọi domain tool của
 * một người dùng đã cấu hình xong, buộc họ OAuth lại vô cớ.
 *
 * Lỗi đọc store KHÔNG chặn request: state ở lại 'awaiting_setup' nên domain tool
 * vẫn bị gác, còn `config`/`help` vẫn gọi được để người dùng chẩn đoán. Và không
 * ghi vào `warmedSubjects` khi thất bại -- một lần KV rớt không được đóng đinh
 * người dùng vào 'awaiting_setup' cho tới lần recreate sau.
 */
async function warmSubjectState(sub: string): Promise<void> {
  if (warmedSubjects.has(sub)) return
  try {
    await resolveCredentialState()
    warmedSubjects.add(sub)
  } catch (err) {
    console.error(
      `[${SERVER_NAME}] could not read the credential store for this session: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Bucket credential cho một request đã qua Bearer verify.
 *
 * Ném khi claims không mang `sub` dùng được. mcp-dev invariant 7: remote mode
 * PHẢI keyed theo JWT sub, không được âm thầm rơi về một blob dùng chung -- hai
 * caller không có sub mà cùng vào một bucket là đúng lỗi cách ly credential mà
 * invariant đó tồn tại để chặn. `authScope` không nhận `res` nên ném là cách
 * chặn duy nhất: mcp-core để lỗi nổi lên handler ngoài cùng, trả HTTP 500 và
 * KHÔNG chạy tool. Thô về status code, nhưng fail closed.
 */
function subjectFromClaims(claims: { sub?: unknown; anonymous?: unknown }): string {
  if (claims.anonymous === true) return ANONYMOUS_BUCKET
  if (typeof claims.sub === 'string' && claims.sub.length > 0) return claims.sub
  throw new Error('Refusing the request: the verified token carries no usable `sub` to key this user credentials by.')
}

export async function startHttp(): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is required for http mode.')
  }
  if (!clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is required for http mode.')
  }

  // Hai thứ đều đứng trên CREDENTIAL_SECRET, nên thiếu nó thì chế độ này không
  // chạy đúng được: (1) bucket per-sub của PerPluginStore derive khoá AES từ nó,
  // (2) JWTIssuer của mcp-core derive khoá Ed25519 từ nó thay vì ghi khoá RS256
  // ra FS container EPHEMERAL -- ghi ra đó thì OAuth identity vỡ mỗi lần recreate.
  // Cả hai chỉ nổ lúc GHI (giữa luồng consent của người dùng), nên chặn ở startup.
  if (!process.env.CREDENTIAL_SECRET) {
    throw new Error(
      'CREDENTIAL_SECRET is required for http mode: per-subject credential buckets derive their encryption key from it, and without it the JWT signing key lands on the ephemeral container filesystem.'
    )
  }

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0
  const host = process.env.HOST

  const handle = await runHttpServer(
    () => {
      // Một Server cho mỗi MCP session (mcp-core gọi factory này per session).
      // Cast như `oauth-setup.ts`: mcp-core khai kiểu McpServer nhưng chỉ gọi
      // `.connect(transport)`, thứ mà Server tầng thấp cũng có.
      const server = new Server({ name: SERVER_NAME, version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } })
      registerTools(server)
      return server as unknown as McpServer
    },
    {
      serverName: SERVER_NAME,
      port,
      host,
      // KHÔNG truyền `authDisabled`. Ràng buộc M3: không bật cờ auth-bypass trên
      // hạ tầng của repo. Sâu hơn: ở chế độ đó mcp-core cấp claims anonymous,
      // không có sub để keyed credential -- tức mâu thuẫn trực tiếp với
      // invariant 7. Không wire vào thì `MCP_AUTH_DISABLE` trong env vô hiệu.
      delegatedOAuth: {
        flow: 'redirect',
        sessionKv: sessionKvForDeploy(),
        upstream: {
          authorizeUrl: GOOGLE_AUTHORIZE_URL,
          tokenUrl: GOOGLE_TOKEN_URL,
          clientId,
          clientSecret,
          scopes: WORKSPACE_SCOPES,
          tokenEndpointAuthMethod: 'client_secret_post', // Google nhận cả hai; post đơn giản hơn
          authorizeParams: { access_type: 'offline', prompt: 'consent' } // điều kiện để Google trả refresh_token
        },
        onTokenReceived: async (tokens) => {
          const sub = deriveSubject(tokens as Record<string, unknown>)
          // AWAIT, không fire-and-forget: mcp-core bọc callback này trong
          // try/catch và trả 500 "Failed to persist tokens" ra browser, nên store
          // hỏng lộ ra ngay lúc auth thay vì mất token âm thầm khi container bị
          // recreate. Ghi vào bucket của chính sub vừa derive -- getAuth() đọc
          // subject context, nên phải nằm TRONG runWithSubject.
          await runWithSubject(sub, async () => {
            await getAuth().saveTokens(tokens as unknown as GoogleTokens)
            // Bucket này vừa có credential: cập nhật state của chính nó, đừng để
            // request đầu tiên sau consent thấy 'awaiting_setup'.
            await resolveCredentialState()
            warmedSubjects.add(sub)
          })
          // Trả sub để mcp-core nhét vào claim `sub` của bearer JWT, thứ mà
          // authScope dưới đây map ngược lại về đúng bucket.
          return sub
        }
      },
      authScope: async (claims, next) => {
        const sub = subjectFromClaims(claims)
        await runWithSubject(sub, async () => {
          await warmSubjectState(sub)
          await next()
        })
      }
    }
  )

  console.error(`[${SERVER_NAME}] http mode on http://${handle.host}:${handle.port}/mcp`)

  // Socket đang listen đã đủ giữ event loop sống; chỗ chờ này là để SIGINT/SIGTERM
  // đi qua `handle.close()` (đóng transport + xoá lock file) thay vì bị cắt ngang.
  await new Promise<void>((resolve) => {
    const shutdown = async (): Promise<void> => {
      await handle.close()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
