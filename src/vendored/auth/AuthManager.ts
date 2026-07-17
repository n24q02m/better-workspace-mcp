// Shim implementing the upstream AuthManager contract (getAuthenticatedClient)
// so byte-identical vendored services run unmodified over our mcp-core auth.
// Real credential logic lives in src/auth/WorkspaceAuth. Upstream's
// AuthManager(scopes) + getAuthenticatedClient() surface is preserved.
import type { Auth } from 'googleapis'
import { getAuth } from '../../auth/credential-state.js'

export class AuthManager {
  constructor(public readonly scopes: string[] = []) {}
  async getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
    return getAuth().getAuthenticatedClient()
  }
}
