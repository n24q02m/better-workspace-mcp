import { BASE_SCOPES } from '../constants.js'
import { WorkspaceAuth } from './workspace-auth.js'

export type CredentialState = 'awaiting_setup' | 'configured'

let _state: CredentialState = 'awaiting_setup'
const _auth = new WorkspaceAuth(BASE_SCOPES)

export function getState(): CredentialState {
  return _state
}
export function getAuth(): WorkspaceAuth {
  return _auth
}

export async function resolveCredentialState(): Promise<CredentialState> {
  try {
    await _auth.getAuthenticatedClient()
    _state = 'configured'
  } catch {
    _state = 'awaiting_setup'
  }
  return _state
}

export async function resetState(): Promise<void> {
  await _auth.clear()
  _state = 'awaiting_setup'
}
