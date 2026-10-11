export const SERVER_NAME = 'workspace'

// Credential namespace for PerPluginStore. Deliberately NOT renamed with SERVER_NAME:
// mcp-core hard-codes the on-disk base as ~/.${plugin}-mcp (credPath, LocalFsBackend,
// and the machine key at ~/.${plugin}-mcp/.secret), so 'better-workspace' still
// resolves to ~/.better-workspace-mcp. The same string is also the scrypt salt
// prefix (`${plugin}:${sub}`) of every HTTP multi-user blob and the KV key prefix,
// so changing it would orphan existing credentials, not move them. The target
// data dir ~/.workspace needs a base-dir option in the storage core first.
export const STORE_PLUGIN = 'better-workspace'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// openid+email → id_token with a stable `sub` (deriveSubject). Workspace domains added per-service.
export const BASE_SCOPES = ['openid', 'email', 'profile']
