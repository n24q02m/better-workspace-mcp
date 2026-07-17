export const SERVER_NAME = 'better-workspace-mcp'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// openid+email → id_token with a stable `sub` (deriveSubject). Workspace domains added per-service.
export const BASE_SCOPES = ['openid', 'email', 'profile']
