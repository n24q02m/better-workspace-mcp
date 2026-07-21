import { PerPluginStore } from '@n24q02m/mcp-core/storage'
import { type Auth, google } from 'googleapis'
import { STORE_PLUGIN } from '../constants.js'

export interface GoogleTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  scope?: string
  token_type?: string
}

export class WorkspaceAuth {
  private cachedClient?: Auth.OAuth2Client
  private store = new PerPluginStore(STORE_PLUGIN) // single-user stdio: sub=null → LocalFsBackend (~/.better-workspace-mcp/config.json)

  // scopes kept for parity with the upstream AuthManager(scopes) contract; not currently read
  // by the OAuth setup flow, which uses its own WORKSPACE_SCOPES (see oauth-setup.ts).
  constructor(public readonly scopes: string[]) {}

  async saveTokens(tokens: GoogleTokens): Promise<void> {
    // Google's raw token response carries expires_in (relative seconds), not expiry_date
    // (absolute ms). Compute it here so getAuthenticatedClient can refresh proactively
    // instead of only reacting to a 401.
    const withExpiry = { ...tokens }
    const rawExpiresIn = (tokens as unknown as Record<string, unknown>).expires_in
    if (withExpiry.expiry_date === undefined && typeof rawExpiresIn === 'number') {
      withExpiry.expiry_date = Date.now() + rawExpiresIn * 1000
    }
    await this.store.save(withExpiry as unknown as Record<string, unknown>)
  }

  async clear(): Promise<void> {
    await this.store.clear()
    this.cachedClient = undefined
  }

  async getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
    if (this.cachedClient) return this.cachedClient
    const raw = (await this.store.load()) as GoogleTokens | null
    if (!raw?.access_token) {
      throw new Error(
        'Google account not configured. Start the server once to complete the browser OAuth consent (see setup docs).'
      )
    }
    const client = new google.auth.OAuth2({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET
    })
    client.setCredentials({
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expiry_date: raw.expiry_date,
      scope: raw.scope,
      token_type: raw.token_type
    })
    // Persist auto-refreshed tokens so a fresh access_token survives restarts.
    // Merge order matters: {...raw, ...t} keeps the stored refresh_token because
    // google-auth-library's 'tokens' event omits refresh_token on a refresh grant
    // (it's re-attached by the library AFTER this emit). Never flip to {...t, ...raw}.
    client.on('tokens', (t) => {
      void this.saveTokens({ ...raw, ...t } as GoogleTokens)
      if (this.cachedClient) {
        this.cachedClient.setCredentials({ ...this.cachedClient.credentials, ...t })
      }
    })
    this.cachedClient = client
    return client
  }
}
