import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// @cloudflare/containers imports `cloudflare:workers`, which only exists in the
// Workers runtime and cannot load under Node/vitest. Mock it: Container as a
// plain base class (real field initializers like `sleepAfter = '5m'` still run
// against it, so WorkspaceContainer can be constructed and its real fields
// read) + a ContainerProxy stub for the entrypoint re-export.
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    env: unknown
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env ?? {}
    }
  },
  ContainerProxy: class {}
}))

import worker, {
  CONTAINER_ENV_KEYS,
  CONTAINER_FIXED_ENV,
  OUTBOUND_BY_HOST,
  pickContainerEnv,
  WorkspaceContainer
} from '../src/worker'

function fakeEnv() {
  const kv = new Map<string, ArrayBuffer>()
  return {
    KV: {
      get: async (k: string, _type?: 'arrayBuffer') => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: ArrayBuffer) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k)
    }
  }
}

// Invoke an outbound handler DIRECTLY (the production path is the container
// proxy via WorkspaceContainer.outboundByHost; the handlers are NOT reachable
// through the public `fetch` entrypoint, so tests exercise them through the
// exported registry).
const kvH = OUTBOUND_BY_HOST['kv.internal']!

// Spies on a WORKSPACE binding's idFromName, shared by the edge-auth-gate and
// single-DO-collapse blocks below.
function envWithDoSpy() {
  const calls: string[] = []
  return {
    calls,
    env: {
      WORKSPACE: {
        idFromName: (n: string) => {
          calls.push(n)
          return { name: n }
        },
        get: (_id: unknown) => ({ fetch: async () => new Response('do-hit', { status: 200 }) })
      }
    }
  }
}

describe('container env forwarding', () => {
  it('forwards CREDENTIAL_SECRET so JWT identity and credential buckets survive a recreate', () => {
    expect(CONTAINER_ENV_KEYS).toContain('CREDENTIAL_SECRET')
  })

  // Dropping this from the forwarded env turns the deployed server into an open
  // self-service relay: /authorize stops gating behind /login even though the
  // OAuth step itself is delegated to Google. It happened for real on the
  // sibling telegram + notion deploys on 2026-06-16.
  it('forwards MCP_RELAY_PASSWORD so Gate A actually gates /authorize', () => {
    expect(CONTAINER_ENV_KEYS).toContain('MCP_RELAY_PASSWORD')
  })

  // mcp-core binds 127.0.0.1 by default; without HOST the container "is not
  // listening in the TCP address 10.0.0.1:8080" and CF cannot reach it at all.
  it('forwards the storage and listen wiring the container needs', () => {
    expect(CONTAINER_ENV_KEYS).toContain('MCP_STORAGE_BACKEND')
    expect(CONTAINER_ENV_KEYS).toContain('MCP_KV_BASE_URL')
    expect(CONTAINER_ENV_KEYS).toContain('PUBLIC_URL')
    expect(CONTAINER_ENV_KEYS).toContain('HOST')
    expect(CONTAINER_ENV_KEYS).toContain('PORT')
    expect(CONTAINER_ENV_KEYS).toContain('MCP_TRANSPORT')
  })

  // Constraint: never enable an auth-bypass flag on this infra. Forwarding it
  // would also collapse every JWT sub into one credential bucket.
  it('never forwards MCP_AUTH_DISABLE', () => {
    expect(CONTAINER_ENV_KEYS).not.toContain('MCP_AUTH_DISABLE')
    expect(Object.keys(CONTAINER_FIXED_ENV)).not.toContain('MCP_AUTH_DISABLE')
  })

  it('pins MCP_NO_BROWSER so the container does not chase a browser it does not have', () => {
    expect(CONTAINER_FIXED_ENV.MCP_NO_BROWSER).toBe('1')
    expect(pickContainerEnv({} as never).MCP_NO_BROWSER).toBe('1')
  })
})

describe('Web-client rename (Google binds redirect URIs to the client TYPE)', () => {
  const workerEnv = {
    MCP_TRANSPORT: 'http',
    GOOGLE_OAUTH_WEB_CLIENT_ID: 'web-client-id',
    GOOGLE_OAUTH_WEB_CLIENT_SECRET: 'web-client-secret'
  } as never

  it('feeds the Web client values to the plain names the server reads', () => {
    const out = pickContainerEnv(workerEnv)
    expect(out.GOOGLE_OAUTH_CLIENT_ID).toBe('web-client-id')
    expect(out.GOOGLE_OAUTH_CLIENT_SECRET).toBe('web-client-secret')
  })

  it('does not leak the _WEB_ spelling into the container (the server never reads it)', () => {
    const out = pickContainerEnv(workerEnv)
    expect(out).not.toHaveProperty('GOOGLE_OAUTH_WEB_CLIENT_ID')
    expect(out).not.toHaveProperty('GOOGLE_OAUTH_WEB_CLIENT_SECRET')
  })

  // Guards the whole point of the rename: the Desktop pair (loopback redirect,
  // used by stdio) must never be what a remote deploy authorizes with, so a
  // Desktop-named value sitting in the Worker env is ignored rather than
  // silently preferred.
  it('ignores a Desktop-named value in the Worker env', () => {
    const out = pickContainerEnv({
      GOOGLE_OAUTH_CLIENT_ID: 'desktop-client-id',
      GOOGLE_OAUTH_WEB_CLIENT_ID: 'web-client-id'
    } as never)
    expect(out.GOOGLE_OAUTH_CLIENT_ID).toBe('web-client-id')
  })

  it('drops unset and empty values instead of injecting a blank', () => {
    const out = pickContainerEnv({ PUBLIC_URL: '', HOST: '0.0.0.0' } as never)
    expect(out).not.toHaveProperty('PUBLIC_URL')
    expect(out.HOST).toBe('0.0.0.0')
  })
})

// The drift guard. A hand-written list of "keys the server needs" rots the
// moment someone adds a `process.env.X` read; this reads the server source
// instead and forces every env var it touches to be classified. A missing key
// does not fail the deploy -- it fails the first request that needed it -- so
// the classification has to happen here, at commit time.
describe('CONTAINER_ENV_KEYS covers every env var the server actually reads', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url))

  // Every env var read by the server that is deliberately NOT forwarded, with
  // the reason. Adding a var here is a decision; leaving it unclassified fails.
  const NOT_FORWARDED: Record<string, string> = {
    NODE_ENV:
      'Set by the Dockerfile (production). Forwarding it risks pinning it to "test", which disables mcp-core behaviour.',
    NO_BROWSER: 'Legacy alias of MCP_NO_BROWSER, which CONTAINER_FIXED_ENV already pins.',
    TRANSPORT_MODE:
      'Legacy alias of MCP_TRANSPORT, which is forwarded. Two switches for one choice is how they end up disagreeing.',
    BETTER_WORKSPACE_MCP_BOOTSTRAPPED:
      'Set by main.ts on itself to detect a double start. Injecting it would make the server refuse to boot.',
    MCP_AUTH_DISABLE:
      'Auth-bypass flag. Never enabled on this infra, and it would collapse every JWT sub into one bucket.'
  }

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      // src/vendored/** is upstream Apache-2.0 code (reads no env vars today,
      // and this walk would catch it if that ever changed) -- it is skipped
      // because it is not ours to classify. src/worker.ts is the Worker side of
      // the boundary: its `env.X` reads are the SOURCE names, not what the
      // container reads.
      if (entry.isDirectory()) {
        if (entry.name !== 'vendored') out.push(...walk(full))
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'worker.ts') {
        out.push(full)
      }
    }
    return out
  }

  // Matches both `process.env.FOO` and the destructured `env.FOO` form that
  // main.ts's getTransportMode(env = process.env) uses -- the latter is why a
  // plain /process\.env\./ scan would miss MCP_TRANSPORT entirely.
  const ENV_REF = /\benv\.([A-Z][A-Z0-9_]{2,})\b/g

  const found = new Map<string, string>()
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(ENV_REF)) {
      if (!found.has(m[1]!)) found.set(m[1]!, file)
    }
  }

  it('finds env reads at all (a scan that matches nothing would pass vacuously)', () => {
    expect(found.size).toBeGreaterThan(5)
    expect([...found.keys()]).toContain('GOOGLE_OAUTH_CLIENT_ID')
    expect([...found.keys()]).toContain('MCP_TRANSPORT')
  })

  it('classifies every env var the server reads as either forwarded or deliberately not', () => {
    const forwarded = new Set<string>([...CONTAINER_ENV_KEYS, ...Object.keys(CONTAINER_FIXED_ENV)])
    const unclassified = [...found.entries()]
      .filter(([name]) => !forwarded.has(name) && !(name in NOT_FORWARDED))
      .map(([name, file]) => `${name} (read in ${file})`)

    expect(unclassified).toEqual([])
  })

  it('does not forward anything the NOT_FORWARDED list rules out', () => {
    for (const name of Object.keys(NOT_FORWARDED)) {
      expect(CONTAINER_ENV_KEYS).not.toContain(name)
    }
  })
})

describe('outbound registry (KV-only)', () => {
  it('registers a kv.internal outbound handler', () => {
    expect(WorkspaceContainer.outboundByHost['kv.internal']).toBeDefined()
    expect(OUTBOUND_BY_HOST['kv.internal']).toBeDefined()
  })

  it('does NOT register d1/vectorize handlers (KV-only)', () => {
    expect(Object.keys(WorkspaceContainer.outboundByHost)).toEqual(['kv.internal'])
    expect(OUTBOUND_BY_HOST['d1.internal']).toBeUndefined()
    expect(OUTBOUND_BY_HOST['vectorize.internal']).toBeUndefined()
  })
})

describe('outbound handlers', () => {
  it('KV get 404 then put then get 200 (binary arrayBuffer round-trip)', async () => {
    const env = fakeEnv()
    const key = 'better-workspace%2Fsubs%2Fu1%2Fconfig'
    const blob = new Uint8Array([1, 2, 3, 250, 0, 99]).buffer

    let res = await kvH(new Request(`http://kv.internal/${key}`), env as never)
    expect(res.status).toBe(404)

    res = await kvH(new Request(`http://kv.internal/${key}`, { method: 'PUT', body: blob }), env as never)
    expect(res.status).toBe(200)

    res = await kvH(new Request(`http://kv.internal/${key}`), env as never)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(blob))
  })

  it('KV DELETE returns 200', async () => {
    const env = fakeEnv()
    const res = await kvH(
      new Request('http://kv.internal/better-workspace%2Fconfig', { method: 'DELETE' }),
      env as never
    )
    expect(res.status).toBe(200)
  })

  it('rejects an unsupported method with 405', async () => {
    const env = fakeEnv()
    const res = await kvH(
      new Request('http://kv.internal/better-workspace%2Fconfig', { method: 'PATCH' }),
      env as never
    )
    expect(res.status).toBe(405)
  })

  it('KV readiness probe: GET __ready -> {ready:true}', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/__ready'), env as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true })
  })

  it('readiness probe does not shadow a real missing key', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-workspace%2Fsubs%2Fu1%2Fconfig'), env as never)
    expect(res.status).toBe(404)
  })
})

describe('KV key prefix confinement', () => {
  it('allows keys under the better-workspace/ prefix', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-workspace/config'), env as never)
    // 404 = it passed the prefix check and hit a missing KV key.
    expect(res.status).toBe(404)
  })

  // The prefix must stay in lock-step with STORE_PLUGIN and with the prefix
  // transports/http.ts gives its delegated-OAuth session KV: a mismatch is a
  // silent 403 with no other signal.
  it('rejects a sibling app prefix (403)', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-notion/config'), env as never)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('forbidden')
  })

  it('rejects a prefix that only looks right (403)', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-workspace-evil/config'), env as never)
    expect(res.status).toBe(403)
  })

  // Plain traversal never reaches the `/..` guard: `new URL()` normalises
  // `/better-workspace/../secret` to `/secret` first, so it is the PREFIX check
  // that rejects it. Kept because that is the outcome that matters.
  it('rejects plain path traversal (403, via the prefix check after URL normalisation)', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-workspace/../secret'), env as never)
    expect(res.status).toBe(403)
  })

  // ENCODED traversal is what the `/..` guard is actually for: %2F survives URL
  // normalisation, so the path still starts with the allowed prefix and only
  // the later decodeURIComponent reveals the escape.
  it('rejects encoded traversal that survives URL normalisation (403)', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-workspace%2F..%2F..%2Fsecret'), env as never)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('forbidden')
  })

  it('rejects an encoded trailing-.. traversal (403)', async () => {
    const env = fakeEnv()
    const res = await kvH(new Request('http://kv.internal/better-workspace%2Fsubs%2F..'), env as never)
    expect(res.status).toBe(403)
  })
})

describe('public fetch entrypoint does NOT expose outbound handlers (security)', () => {
  it('a public request with an internal hostname is NOT serviced by a handler', async () => {
    const env = fakeEnv() // no WORKSPACE binding -> DO routing path returns 404
    // Even if an external caller spoofs the hostname to kv.internal, the public
    // fetch must NOT read/write the credential KV -- it only routes to the DO.
    const res = await worker.fetch(new Request('http://kv.internal/better-workspace%2Fconfig'), env as never)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
  })
})

describe('edge auth gate (an anonymous /mcp must never reach the container)', () => {
  it('POST /mcp with no Authorization -> 401 + RFC 9728, DO never touched', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(new Request('https://workspace.n24q02m.com/mcp', { method: 'POST' }), env as never)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://workspace.n24q02m.com/.well-known/oauth-protected-resource"'
    )
    expect(calls).toEqual([])
  })

  it('OPTIONS /mcp with no Authorization -> 401 (no CORS exemption), DO never touched', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp', { method: 'OPTIONS' }),
      env as never
    )
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('GET /mcp with no Authorization -> 401 (bearer gate runs before the 405 gate)', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(new Request('https://workspace.n24q02m.com/mcp', { method: 'GET' }), env as never)
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('a malformed Authorization header (no scheme) -> 401', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp', { method: 'POST', headers: { authorization: 'sometoken' } }),
      env as never
    )
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('"Bearer" with no token -> 401', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp', { method: 'POST', headers: { authorization: 'Bearer ' } }),
      env as never
    )
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('POST /mcp with any Bearer -> reaches the DO (validity is the container job)', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer anything' }
      }),
      env as never
    )
    expect(res.status).toBe(200)
    expect(calls).toEqual(['default'])
  })

  it('/mcp sub-paths are gated too', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(new Request('https://workspace.n24q02m.com/mcp/x', { method: 'POST' }), env as never)
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  // Documents the deliberate hole: the OAuth AS lives INSIDE the container, so
  // /authorize, /callback, /token and /.well-known must reach it unauthenticated.
  // Those paths can still wake the container -- see the report on residual cost.
  it('non-/mcp paths still reach the DO without a Bearer (the OAuth AS is in the container)', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(new Request('https://workspace.n24q02m.com/authorize?foo=1'), env as never)
    expect(res.status).toBe(200)
    expect(calls).toEqual(['default'])
  })
})

describe('standing GET /mcp SSE decline (an open stream pins the container awake 24/7)', () => {
  it('GET /mcp with a Bearer -> 405, Allow: POST, DELETE, DO never touched', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp', { method: 'GET', headers: { authorization: 'Bearer x' } }),
      env as never
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST, DELETE')
    expect(calls).toEqual([])
  })

  it('GET /mcp/sub with a Bearer -> 405 (sub-path also declines the stream)', async () => {
    const { calls, env } = envWithDoSpy()
    const res = await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp/sub', { method: 'GET', headers: { authorization: 'Bearer x' } }),
      env as never
    )
    expect(res.status).toBe(405)
    expect(calls).toEqual([])
  })
})

describe('single-DO collapse', () => {
  it('a Bearer carrying a sub still routes to the one "default" DO', async () => {
    const { calls, env } = envWithDoSpy()
    const jwt = `h.${btoa(JSON.stringify({ sub: 'user-123' }))}.s`
    await worker.fetch(
      new Request('https://workspace.n24q02m.com/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` }
      }),
      env as never
    )
    // Per-sub DO routing deadlocks under max_instances=1 and splits the
    // /authorize -> /callback handshake across two containers. Isolation comes
    // from PerPluginStore keying, not from DO identity.
    expect(calls).toEqual(['default'])
  })

  it('two different subs share the same DO', async () => {
    const { calls, env } = envWithDoSpy()
    for (const sub of ['alice', 'bob']) {
      const jwt = `h.${btoa(JSON.stringify({ sub }))}.s`
      await worker.fetch(
        new Request('https://workspace.n24q02m.com/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}` }
        }),
        env as never
      )
    }
    expect(calls).toEqual(['default', 'default'])
  })
})

describe('container cost + readiness config', () => {
  const c = new WorkspaceContainer(undefined as never, {} as never)

  // Container memory (GiB-s) is the dominant line on the CF bill. An idle
  // window in hours -- or none at all -- bills a warm container around the clock.
  it('sleeps after an idle window measured in minutes', () => {
    expect(c.sleepAfter).toMatch(/^\d+m$/)
    expect(Number.parseInt(String(c.sleepAfter), 10)).toBeLessThanOrEqual(10)
  })

  it('serves on 8080, matching the Dockerfile http target', () => {
    expect(c.defaultPort).toBe(8080)
  })

  it('probes /health, not the default unresolvable "ping"', () => {
    expect(c.pingEndpoint).toBe('localhost/health')
  })

  it('reaches the public internet (Google APIs) while kv.internal stays intercepted', () => {
    expect(c.enableInternet).toBe(true)
  })
})
