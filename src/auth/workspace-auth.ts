import { PerPluginStore } from '@n24q02m/mcp-core/storage'
import { type Auth, google } from 'googleapis'
import { SERVER_NAME } from '../constants.js'

export interface GoogleTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  scope?: string
  token_type?: string
}

export class WorkspaceAuth {
  private store = new PerPluginStore(SERVER_NAME) // single-user stdio: sub=null → LocalFsBackend (~/.better-workspace-mcp/config.json)

  // scopes kept for parity with the upstream AuthManager(scopes) contract; used by the OAuth setup flow (Task 5).
  constructor(public readonly scopes: string[]) {}

  async saveTokens(tokens: GoogleTokens): Promise<void> {
    await this.store.save(tokens as unknown as Record<string, unknown>)
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }

  async getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
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
    client.on('tokens', (t) => {
      void this.saveTokens({ ...raw, ...t } as GoogleTokens)
    })
    return client
  }
}
