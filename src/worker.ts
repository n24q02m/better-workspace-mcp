// src/worker.ts
// Worker fronting the better-workspace-mcp container Durable Object.
//
// Two distinct request paths:
//  - INBOUND: requests on the custom domain hit the default export `fetch`,
//    which routes them to the WorkspaceContainer Durable Object.
//  - OUTBOUND: the container calls http://kv.internal/... which is intercepted
//    by the `@cloudflare/containers` proxy and dispatched to the
//    `WorkspaceContainer.outboundByHost` handlers below, serviced from the
//    Worker's KV binding. enableInternet=true lets every OTHER host
//    (accounts.google.com, oauth2.googleapis.com, www.googleapis.com) reach the
//    public internet.
//
// workspace is KV-only: it has no docs DB and no vectors, so the d1.internal /
// vectorize.internal handlers from the wet template are intentionally dropped.
import { Container, ContainerProxy, type OutboundHandler } from '@cloudflare/containers'

// ContainerProxy must be re-exported from the Worker entrypoint: the containers
// runtime discovers it via `ctx.exports.ContainerProxy` to route the container's
// intercepted outbound traffic (kv.internal) back into the Worker. Without this
// re-export, applyOutboundInterception() throws at container start.
export { ContainerProxy }

export interface Env {
  KV: {
    get(k: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
    get(k: string): Promise<string | null>
    put(k: string, v: string | ArrayBuffer): Promise<void>
    delete(k: string): Promise<void>
  }
  WORKSPACE?: { idFromName(n: string): unknown; get(id: unknown): { fetch(r: Request): Promise<Response> } }
  // Container config (wrangler.jsonc `vars`) + secrets (`wrangler secret put`),
  // forwarded into the container process via WorkspaceContainer.envVars.
  MCP_TRANSPORT: string
  MCP_STORAGE_BACKEND: string
  MCP_KV_BASE_URL: string
  PUBLIC_URL: string
  PORT: string
  // mcp-core core-ts defaults the listen host to 127.0.0.1 (local-server.ts).
  // The CF container is reachable only when the server binds 0.0.0.0:8080, so
  // HOST=0.0.0.0 is forwarded. Without it the container "is not listening in
  // the TCP address 10.0.0.1:8080".
  HOST: string
  // `transports/http.ts` REFUSES to start without this, by design: per-subject
  // credential buckets derive their AES key from it, and mcp-core's JWTIssuer
  // derives its Ed25519 key from it instead of writing an RS256 key to the
  // EPHEMERAL container filesystem (which breaks OAuth identity on recreate).
  CREDENTIAL_SECRET: string
  // Gate A (shared relay-password front door). Forwarding it gates /authorize
  // behind /login like the OCI VM; omitting it leaves an open self-service relay
  // even though the OAuth step itself is delegated to Google.
  MCP_RELAY_PASSWORD: string
  // The GOOGLE_OAUTH_**WEB**_* naming is deliberate -- see CONTAINER_ENV_SOURCES.
  GOOGLE_OAUTH_WEB_CLIENT_ID: string
  GOOGLE_OAUTH_WEB_CLIENT_SECRET: string
}

/**
 * Container env var -> the Worker env var its value comes from.
 *
 * Almost every entry is an identity mapping. The two Google entries are NOT,
 * and that is not a copy-paste slip:
 *
 * Google binds redirect URIs to the OAuth *client type*. A **Desktop** client
 * may redirect to any loopback port, which is what stdio mode needs (it spawns
 * a throwaway consent server on a random port). A **Web** client may only
 * redirect to URIs registered ahead of time, which is what this deploy needs
 * (`https://workspace.n24q02m.com/callback` + `/accounts/callback`). They are
 * two different clients with two different secrets, and the repo keeps both:
 * skret `/better-workspace-mcp/prod` holds `GOOGLE_OAUTH_CLIENT_ID/SECRET`
 * (Desktop, for stdio) alongside `GOOGLE_OAUTH_WEB_CLIENT_ID/SECRET` (Web, for
 * here). Overwriting the first pair with Web values would break every stdio
 * install, so the two names must stay distinct all the way to the edge.
 *
 * The container, meanwhile, only ever runs http mode and reads the plain
 * `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` names (`transports/http.ts`,
 * `auth/workspace-auth.ts`). Renaming here -- rather than teaching `http.ts`
 * about a `_WEB_` spelling -- keeps the rename in one place and keeps the
 * server itself ignorant of Cloudflare. The CF secret names then match the
 * skret key names exactly, so the deploy step is a straight copy with nothing
 * to mistranslate.
 */
const CONTAINER_ENV_SOURCES = {
  MCP_TRANSPORT: 'MCP_TRANSPORT',
  MCP_STORAGE_BACKEND: 'MCP_STORAGE_BACKEND',
  MCP_KV_BASE_URL: 'MCP_KV_BASE_URL',
  PUBLIC_URL: 'PUBLIC_URL',
  PORT: 'PORT',
  HOST: 'HOST',
  CREDENTIAL_SECRET: 'CREDENTIAL_SECRET',
  MCP_RELAY_PASSWORD: 'MCP_RELAY_PASSWORD',
  GOOGLE_OAUTH_CLIENT_ID: 'GOOGLE_OAUTH_WEB_CLIENT_ID',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOOGLE_OAUTH_WEB_CLIENT_SECRET'
} as const satisfies Record<string, keyof Env>

/**
 * Env var names as the CONTAINER sees them (the left-hand side above). Exported
 * for the env-forwarding regression tests: a key dropped from this list does not
 * fail the deploy, it fails the first request that needed it -- which is why
 * `tests/worker.test.ts` asserts the list against what the server source
 * actually reads instead of against a hand-written duplicate.
 */
export const CONTAINER_ENV_KEYS = Object.keys(CONTAINER_ENV_SOURCES) as (keyof typeof CONTAINER_ENV_SOURCES)[]

/**
 * Env vars whose value is a property of the container runtime, not a
 * deployment choice, so they are pinned here rather than in wrangler.jsonc
 * `vars` where an edit could silently drop them.
 *
 * MCP_NO_BROWSER: mcp-core auto-opens the setup URL at startup whenever the
 * stored config is incomplete (`transport/local-server.js`, the
 * `if (!configComplete && NODE_ENV !== 'test')` branch). In a fresh container
 * the store is always empty, so that branch always runs -- and there is no
 * browser to open, only an `xdg-open` that does not exist in the image. The
 * call is wrapped in try/catch so it cannot crash startup; setting this simply
 * makes `tryOpenBrowser` return false immediately instead of spawning a doomed
 * subprocess and printing a "a browser tab should have opened" banner that is
 * false on a server. (mcp-core >= 1.22 exposes an `openBrowser: false` option;
 * this repo pins 1.20.0, where the env var is the only switch.)
 */
export const CONTAINER_FIXED_ENV: Record<string, string> = {
  MCP_NO_BROWSER: '1'
}

/**
 * Build the container's environment from the Worker's. Unset/empty values are
 * dropped so an unused optional secret never injects a blank string (which
 * would read as "set" to the server and defeat its own startup checks).
 */
export function pickContainerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = { ...CONTAINER_FIXED_ENV }
  for (const [containerKey, workerKey] of Object.entries(CONTAINER_ENV_SOURCES)) {
    const v = (env as unknown as Record<string, unknown>)[workerKey]
    if (typeof v === 'string' && v !== '') out[containerKey] = v
  }
  return out
}

// --- Outbound handler (container -> Worker KV binding) ----------------------
// Runs when the container makes an outbound HTTP request to kv.internal. Wired
// via `WorkspaceContainer.outboundByHost` (assignment, NOT a class field) so the
// assignment hits the inherited setter and populates the package's module-level
// handler registry. A `static outboundByHost = {...}` field would use
// define-semantics, bypass the setter, and silently fall through to the public
// internet (kv.internal -> NXDOMAIN).

// Must match STORE_PLUGIN (src/constants.ts) and the prefix that
// `transports/http.ts` gives its delegated-OAuth session KV. A key outside this
// prefix is rejected with 403 and no other signal, so the two must move together.
const KV_PREFIX = 'better-workspace/'

const kvOutbound: OutboundHandler<Env> = async (request, env) => {
  const url = new URL(request.url)
  const key = decodeURIComponent(url.pathname.replace(/^\//, ''))
  // Readiness probe: once this handler answers, outbound interception is wired,
  // so the container's first credential PUT is safe. Reserved key, checked
  // before the normal key lookup so it never shadows a real KV key.
  // Security: restrict KV access to the app's own namespace. Mapping untrusted
  // paths straight to KV keys is how one app reads another's credential blobs.
  if (key !== '__ready' && (!key.startsWith(KV_PREFIX) || key.includes('/../') || key.includes('/..'))) {
    return new Response('forbidden: invalid KV key prefix', { status: 403 })
  }
  if (request.method === 'GET' && key === '__ready') {
    return Response.json({ ready: true })
  }
  if (request.method === 'GET') {
    // Credential blobs are binary (nonce + AES-GCM ciphertext); read/write as
    // ArrayBuffer so bytes round-trip without UTF-8 corruption.
    const v = await env.KV.get(key, 'arrayBuffer')
    return v === null ? new Response('', { status: 404 }) : new Response(v, { status: 200 })
  }
  if (request.method === 'PUT') {
    await env.KV.put(key, await request.arrayBuffer())
    return new Response('', { status: 200 })
  }
  if (request.method === 'DELETE') {
    await env.KV.delete(key)
    return new Response('', { status: 200 })
  }
  return new Response('method not allowed', { status: 405 })
}

// Outbound handler registry, keyed by internal hostname. Production container
// outbound (kv.internal) reaches these via @cloudflare/containers' ContainerProxy
// + the WorkspaceContainer.outboundByHost assignment below -- NOT via the public
// `fetch` export. Exported so unit tests can invoke a handler directly instead of
// routing an internal-host request through the public entrypoint. workspace is
// KV-only (no D1/Vectorize handlers).
export const OUTBOUND_BY_HOST: Record<string, OutboundHandler<Env>> = {
  'kv.internal': kvOutbound
}

// Bearer credential presence check. Structural only -- validity is the container's job.
const BEARER = /^Bearer\s+\S/i

function unauthenticated(request: Request): Response {
  const { origin } = new URL(request.url)
  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    }
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Public entrypoint: ONLY routes inbound requests to the container DO. The
    // kv.internal outbound handler is deliberately NOT dispatched here --
    // exposing it on the public fetch surface would let an external caller
    // (request hostname spoofed to kv.internal) read/write/delete the credential
    // KV namespace unauthenticated. Production container outbound reaches it via
    // @cloudflare/containers' ContainerProxy + the WorkspaceContainer.outboundByHost
    // registry below; unit tests call the handlers directly via the
    // OUTBOUND_BY_HOST export.
    //
    // Edge auth gate. mcp-core's OAuth AS runs INSIDE the container, so without this
    // gate every anonymous /mcp request starts the container and resets its idle
    // timer -- an unauthenticated caller can pin it awake and bill GiB-s around the
    // clock. Verified on the sibling servers 2026-07-09: a python-httpx client POSTed
    // /mcp with no Authorization header every ~20s for 12h+. The check is STRUCTURAL:
    // it rejects requests carrying no bearer credential at all and reproduces the
    // container's own 401 (empty body + RFC 9728 WWW-Authenticate). Token VALIDITY is
    // never judged here -- the container remains the sole authority, so no mcp-core
    // auth logic is duplicated at the edge and a future signing-alg change is not an
    // outage.
    const url = new URL(request.url)
    const isMcp = url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')
    if (isMcp && !BEARER.test(request.headers.get('authorization') ?? '')) {
      return unauthenticated(request)
    }
    // Standing GET /mcp = the streamable-HTTP server-push SSE stream. On a
    // scale-to-zero container this is pure idle cost: @cloudflare/containers
    // counts an open stream as an in-flight request forever (inflight > 0 =>
    // activity never expires), so a single idle client pins the container
    // awake 24/7. This server sends no server-initiated messages;
    // request-scoped notifications ride the POST's own SSE response. The spec
    // allows declining the stream: both official SDKs treat 405 as the
    // optional-feature path and continue POST-only.
    if (request.method === 'GET' && isMcp) {
      return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } })
    }
    if (env.WORKSPACE) {
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(containerIdFor()))
      return stub.fetch(request)
    }
    return new Response('not found', { status: 404 })
  }
}

function containerIdFor(): string {
  // SINGLE-DO COLLAPSE: route EVERY request (OAuth /authorize, /callback,
  // /token, /.well-known AND every sub's /mcp) to the one reserved "default"
  // Durable Object. Under max_instances=1 (the solo-dev cost rule) per-sub-DO
  // routing DEADLOCKS: the OAuth flow (no Bearer yet) warms DO "default" while
  // the first /mcp (Bearer sub) needs DO "<sub>" -- a 2nd container that cannot
  // spawn under max=1 ("Maximum number of running container instances exceeded"
  // 500). It also splits the /authorize -> /callback handshake across two
  // containers.
  //
  // Safe because per-user state is EXTERNALISED, not in-container: `AccountStore`
  // is keyed by JWT sub via PerPluginStore (`subs/<sub>/config`) with a
  // per-sub-derived encryption key, so one container serving all subs leaks
  // nothing between them. (Trade-off: one shared container for all subs; fine
  // for solo / low concurrency.)
  return 'default'
}

// Container Durable Object. wrangler.jsonc binds WORKSPACE to this class and
// runs the registry.cloudflare.com/<ACCOUNT_ID>/better-workspace-mcp:beta image
// (Dockerfile `http` target: MCP_TRANSPORT=http, PORT=8080, EXPOSE 8080).
export class WorkspaceContainer extends Container<Env> {
  defaultPort = 8080
  // Idle window before the container is stopped. Minutes, not hours -- container
  // memory (GiB-s) is the dominant line on the bill. 5m matches the rest of the
  // MCP stack: the delegated-OAuth handshake survives a sleep in between
  // (pending state lives in KV via `sessionKvForDeploy`, not in RAM), so a
  // shorter window would only trade cold-start latency for a few GiB-s.
  // NOTE: this only fires at ZERO in-flight requests. Any client polling faster
  // than this pins the container awake regardless of the value -- that is a
  // client-side fix, not a number to tune here.
  sleepAfter = '5m'
  // Port-readiness probe used by @cloudflare/containers' waitForPort(): it does
  // tcpPort.fetch('http://' + pingEndpoint) against the container's bound port, so
  // the host segment is only a Host header (no DNS) and ANY HTTP response marks the
  // port ready. Pointed at /health because mcp-core serves a cheap 200 there while
  // '/' 302-redirects into the OAuth app.
  pingEndpoint = 'localhost/health'
  // The container reaches accounts.google.com / oauth2.googleapis.com /
  // www.googleapis.com over the public internet; kv.internal stays intercepted
  // (see outboundByHost).
  enableInternet = true
  // Forward Worker config (vars) + secrets into the container process, applying
  // the Web-client rename documented on CONTAINER_ENV_SOURCES.
  envVars = pickContainerEnv(this.env)
}

// Register outbound interception. MUST be an assignment (invokes the inherited
// `static set outboundByHost`) -- a class field would bypass the setter. Reuses
// OUTBOUND_BY_HOST so the proxy registry and the direct test dispatch are one
// source of truth. KV-only: no d1.internal / vectorize.internal.
WorkspaceContainer.outboundByHost = OUTBOUND_BY_HOST as Record<string, OutboundHandler>
