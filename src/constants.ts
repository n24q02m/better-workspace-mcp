export const SERVER_NAME = 'better-workspace-mcp'

// PerPluginStore's LocalFsBackend auto-appends `-mcp` to the plugin name it's given
// (base = ~/.${plugin}-mcp). Passing SERVER_NAME (already ending in `-mcp`) would double
// it to ~/.better-workspace-mcp-mcp/. Use this short name for PerPluginStore instead.
export const STORE_PLUGIN = 'better-workspace'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// openid+email → id_token with a stable `sub` (deriveSubject). Workspace domains added per-service.
export const BASE_SCOPES = ['openid', 'email', 'profile']
