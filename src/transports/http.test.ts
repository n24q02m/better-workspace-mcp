/**
 * Wiring tests cho http transport.
 *
 * `runHttpServer` bị mock: thứ cần kiểm ở đây là OPTIONS mà transport đưa cho
 * mcp-core (delegated OAuth params, authScope, đường từ chối) — hành vi của
 * chính mcp-core đã có test trong repo của nó, dựng socket thật ở đây chỉ làm
 * test chậm mà không kiểm thêm được gì.
 *
 * `startHttp()` chỉ resolve khi nhận SIGINT/SIGTERM, nên các test bắt options
 * dùng `void startHttp()` + `vi.waitFor` thay vì `await`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { credPath, setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: http.ts được import STATIC ở dưới, nên factory của vi.mock chạy
// trước khi thân file kịp khởi tạo biến -- `const` thường sẽ ném "Cannot access
// before initialization" (cùng lý do docs.test.ts và registry.test.ts phải dùng nó).
const { runHttpServerMock, closeSpy } = vi.hoisted(() => {
  const closeSpy = vi.fn(async () => {})
  return {
    closeSpy,
    runHttpServerMock: vi.fn(async (_factory: unknown, _options: unknown) => ({
      host: '127.0.0.1',
      port: 8080,
      close: closeSpy
    }))
  }
})
vi.mock('@n24q02m/mcp-core', () => ({ runHttpServer: runHttpServerMock }))

import { AccountStore } from '../auth/account-store.js'
import { getState } from '../auth/credential-state.js'
import { currentSubject } from '../auth/subject-context.js'
import { STORE_PLUGIN } from '../constants.js'
// Static import, không `await import()` trong từng test: http.ts kéo theo
// googleapis (~10s để nạp) và không đọc env lúc module-load, nên nạp một lần ở
// pha import của vitest thay vì tính chi phí đó vào testTimeout của test đầu tiên.
import { sessionKvForDeploy, startHttp } from './http.js'

interface CapturedOptions {
  serverName: string
  port: number
  host?: string
  authDisabled?: unknown
  delegatedOAuth: {
    flow: string
    sessionKv?: unknown
    upstream: {
      scopes?: string[]
      authorizeParams?: Record<string, string>
      tokenEndpointAuthMethod?: string
    }
    // mcp-core khai `TokenCallback` rộng hơn (`string | undefined | void`); ở đây
    // hẹp lại đúng phần transport này thật sự trả về, để test khẳng định được sub.
    onTokenReceived: (tokens: Record<string, unknown>) => Promise<string | undefined>
  }
  authScope: (claims: Record<string, unknown>, next: () => Promise<void>) => Promise<void>
}

const ENV_KEYS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'CREDENTIAL_SECRET',
  'MCP_STORAGE_BACKEND',
  'MCP_KV_BASE_URL',
  'MCP_AUTH_DISABLE',
  'PORT',
  'HOST'
] as const

const REC = { access_token: 'at', refresh_token: 'rt', expiry_date: 4_000_000_000_000 }

/** id_token không cần chữ ký hợp lệ: chỉ payload được đọc (deriveSubject / emailFromIdToken). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

/** Mỗi sub một tên riêng: cache theo sub của credential-state sống suốt file test. */
let subCounter = 0
const freshSub = (label: string) => `sub-${label}-${++subCounter}`

async function captureOptions(): Promise<CapturedOptions> {
  void startHttp()
  await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())
  return runHttpServerMock.mock.calls[0]?.[1] as CapturedOptions
}

let home: string
let savedEnv: Record<string, string | undefined>
/**
 * `startHttp()` đăng ký handler SIGINT/SIGTERM rồi chờ mãi, nên mỗi test bắt
 * options để lại hai listener trên `process` -- qua 10 test là
 * MaxListenersExceededWarning. Chụp danh sách trước/sau để chỉ bỏ đúng listener
 * do test này thêm, KHÔNG dùng removeAllListeners (sẽ bỏ cả handler của vitest).
 */
const SIGNALS = ['SIGINT', 'SIGTERM'] as const
let signalsBefore: Map<string, unknown[]>

beforeEach(() => {
  signalsBefore = new Map(SIGNALS.map((s) => [s, process.listeners(s)]))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = mkdtempSync(join(tmpdir(), 'bws-http-test-'))
  setHomeDirForTesting(home)
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
  process.env.CREDENTIAL_SECRET = 'test-secret-at-least-32-chars-long-xx'
  delete process.env.MCP_STORAGE_BACKEND
  delete process.env.MCP_KV_BASE_URL
  delete process.env.MCP_AUTH_DISABLE
  delete process.env.PORT
  delete process.env.HOST
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  setHomeDirForTesting(null)
  rmSync(home, { recursive: true, force: true })
  runHttpServerMock.mockClear()
  closeSpy.mockClear()
  for (const signal of SIGNALS) {
    const before = signalsBefore.get(signal) ?? []
    for (const listener of process.listeners(signal)) {
      if (!before.includes(listener)) process.removeListener(signal, listener as () => void)
    }
  }
})

describe('sessionKvForDeploy', () => {
  it('is undefined outside the cf-kv deploy so the session store falls back in-process', () => {
    expect(sessionKvForDeploy()).toBeUndefined()
  })

  it('is defined when the backend is cf-kv', async () => {
    process.env.MCP_STORAGE_BACKEND = 'cf-kv'
    process.env.MCP_KV_BASE_URL = 'http://kv.internal'
    expect(sessionKvForDeploy()).toBeDefined()
  })
})

describe('startHttp — startup refusals', () => {
  it('refuses to start without the Google OAuth client id', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    await expect(startHttp()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
    expect(runHttpServerMock).not.toHaveBeenCalled()
  })

  it('refuses to start without the Google OAuth client secret', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    await expect(startHttp()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_SECRET/)
    expect(runHttpServerMock).not.toHaveBeenCalled()
  })

  // mcp-dev invariant 7: remote mode phải keyed theo JWT sub. Bucket per-sub của
  // PerPluginStore derive khoá mã hoá từ CREDENTIAL_SECRET, thiếu nó thì lần GHI
  // đầu tiên mới ném — tức lỗi rơi vào giữa luồng consent của người dùng. Chặn ở
  // startup thay vì để nó nổ lúc đó.
  it('refuses to start without CREDENTIAL_SECRET (per-subject buckets cannot be keyed without it)', async () => {
    delete process.env.CREDENTIAL_SECRET
    await expect(startHttp()).rejects.toThrow(/CREDENTIAL_SECRET/)
    expect(runHttpServerMock).not.toHaveBeenCalled()
  })
})

describe('startHttp — options handed to mcp-core', () => {
  it('asks Google for offline access and the full workspace scope set', async () => {
    const opts = await captureOptions()
    expect(opts.delegatedOAuth.upstream.authorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' })
    expect(opts.delegatedOAuth.upstream.scopes).toContain('https://www.googleapis.com/auth/forms.body')
    expect(opts.delegatedOAuth.upstream.tokenEndpointAuthMethod).toBe('client_secret_post')
    expect(opts.delegatedOAuth.flow).toBe('redirect')
    expect(opts.serverName).toBe('better-workspace-mcp')
  })

  it('binds the port and host from the environment', async () => {
    process.env.PORT = '8787'
    process.env.HOST = '0.0.0.0'
    const opts = await captureOptions()
    expect(opts.port).toBe(8787)
    expect(opts.host).toBe('0.0.0.0')
  })

  // Ràng buộc M3: không bật cờ auth-bypass trên hạ tầng của repo. Transport này
  // KHÔNG forward MCP_AUTH_DISABLE, nên dù biến có trong env thì mcp-core vẫn
  // enforce Bearer — một người dùng anonymous không thể rơi vào bucket của ai.
  it('never forwards mcp-core auth bypass, even with MCP_AUTH_DISABLE in the environment', async () => {
    process.env.MCP_AUTH_DISABLE = '1'
    const opts = await captureOptions()
    expect(opts.authDisabled).toBeUndefined()
  })

  // mcp-core bị mock nên nó không bao giờ gọi serverFactory; gọi tay ở đây để
  // chính lambda đó được chạy (cùng lý do add-account.test.ts và
  // oauth-setup.test.ts làm vậy) -- registerTools thật chạy trên một Server thật.
  it('builds one MCP server with the tool surface registered per session', async () => {
    await captureOptions()
    const factory = runHttpServerMock.mock.calls[0]?.[0] as () => unknown

    const first = factory()
    const second = factory()

    expect(first).toBeInstanceOf(Server)
    // Mỗi session một Server riêng: dùng chung một instance thì hai client sẽ
    // đụng nhau ở state handshake của SDK.
    expect(second).not.toBe(first)
  })

  it('closes the handle on SIGINT so the transport and lock file are released', async () => {
    await captureOptions()
    // Gọi thẳng listener vừa đăng ký thay vì process.emit('SIGINT'): emit sẽ chạy
    // cả listener của vitest trong worker này.
    const listeners = process.listeners('SIGINT')
    const shutdown = listeners[listeners.length - 1] as () => Promise<void>

    await shutdown()

    expect(closeSpy).toHaveBeenCalledOnce()
  })
})

describe('startHttp — authScope subject resolution', () => {
  it('runs the tool dispatch inside a subject scope taken from the JWT claims', async () => {
    const opts = await captureOptions()
    let seen: string | undefined
    await opts.authScope({ sub: 'sub-from-jwt' }, async () => {
      seen = currentSubject()
    })
    expect(seen).toBe('sub-from-jwt')
  })

  it('maps an anonymous caller to the default bucket', async () => {
    const opts = await captureOptions()
    let seen: string | undefined
    await opts.authScope({ anonymous: true }, async () => {
      seen = currentSubject()
    })
    expect(seen).toBe('default')
  })

  // Đường từ chối phải CHẶN THẬT, không chỉ log: một JWT đã verify nhưng không
  // mang sub dùng được mà bị dồn vào bucket chung = đúng cái invariant 7 cấm.
  // authScope không có `res` nên cách chặn duy nhất là ném — mcp-core để lỗi nổi
  // lên handler ngoài cùng và trả HTTP 500, tức request bị từ chối.
  it('refuses a verified caller with no usable sub instead of sharing a bucket', async () => {
    const opts = await captureOptions()
    let dispatched = false
    const next = async () => {
      dispatched = true
    }
    await expect(opts.authScope({}, next)).rejects.toThrow(/sub/)
    await expect(opts.authScope({ sub: '' }, next)).rejects.toThrow(/sub/)
    await expect(opts.authScope({ sub: 42 }, next)).rejects.toThrow(/sub/)
    expect(dispatched).toBe(false)
  })
})

describe('startHttp — per-subject credential state', () => {
  // Sau khi container bị recreate, map state trong process là rỗng nhưng
  // credential vẫn nằm trong store. Không warm lại thì registry.ts thấy
  // 'awaiting_setup' và chặn mọi domain tool của người dùng đã cấu hình xong.
  it('resolves the calling subject credential state before dispatch', async () => {
    const configured = freshSub('configured')
    const empty = freshSub('empty')
    await new AccountStore(configured).put('a@example.com', REC)

    const opts = await captureOptions()

    let stateOfConfigured: string | undefined
    await opts.authScope({ sub: configured }, async () => {
      stateOfConfigured = getState()
    })
    let stateOfEmpty: string | undefined
    await opts.authScope({ sub: empty }, async () => {
      stateOfEmpty = getState()
    })

    expect(stateOfConfigured).toBe('configured')
    expect(stateOfEmpty).toBe('awaiting_setup')
  })

  it('resolves each subject once, not on every request', async () => {
    const sub = freshSub('cached')
    await new AccountStore(sub).put('a@example.com', REC)
    const opts = await captureOptions()

    await opts.authScope({ sub }, async () => {})
    // Xoá blob sau lần đầu: nếu warm-up chạy lại mỗi request thì lần thứ hai sẽ
    // đọc ra rỗng và tụt về 'awaiting_setup'. Nó giữ 'configured' = đã cache.
    rmSync(credPath(STORE_PLUGIN, sub), { force: true })

    let stateOnSecondRequest: string | undefined
    await opts.authScope({ sub }, async () => {
      stateOnSecondRequest = getState()
    })
    expect(stateOnSecondRequest).toBe('configured')
  })

  // Store hỏng (KV rớt, file không đọc được) KHÔNG được chặn request: `config` và
  // `help` phải còn gọi được để người dùng chẩn đoán. State ở lại 'awaiting_setup'
  // nên domain tool vẫn bị gác — fail closed ở chỗ cần, không fail closed cả cửa.
  it('lets the request through when the credential store cannot be read', async () => {
    const sub = freshSub('broken')
    // Đặt một THƯ MỤC đúng chỗ file blob: readFile trả EISDIR, tức backend lỗi
    // thật (khác ENOENT = "chưa cấu hình", vốn được xử lý như bucket rỗng).
    const blob = credPath(STORE_PLUGIN, sub)
    mkdirSync(dirname(blob), { recursive: true })
    mkdirSync(blob)

    const opts = await captureOptions()
    let dispatched = false
    let state: string | undefined
    await opts.authScope({ sub }, async () => {
      dispatched = true
      state = getState()
    })

    expect(dispatched).toBe(true)
    expect(state).toBe('awaiting_setup')
  })
})

describe('startHttp — onTokenReceived', () => {
  it('writes the consented tokens into the bucket of the subject it derived', async () => {
    const sub = freshSub('consent')
    const opts = await captureOptions()

    const returned = await opts.delegatedOAuth.onTokenReceived({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token: fakeIdToken({ sub, email: 'Owner@Example.com' })
    })

    expect(returned).toBe(sub)
    expect((await new AccountStore(sub).list()).accounts).toEqual(['owner@example.com'])
    // Và không rơi vào bucket nào khác: bucket single-user của stdio phải trống.
    expect((await new AccountStore().list()).accounts).toEqual([])
  })
})
