import { BASE_SCOPES } from '../constants.js'
import { currentSubject } from './subject-context.js'
import { WorkspaceAuth } from './workspace-auth.js'

export type CredentialState = 'awaiting_setup' | 'configured'

/** Khoá bucket của stdio single-user, tương ứng `sub = null` của PerPluginStore. */
const SINGLE_USER = ''

/**
 * Một WorkspaceAuth cho mỗi sub. Map thay vì dựng mới mỗi lần gọi: getAuth() nằm
 * trên đường nóng của mọi tool call (registry -> shim AuthManager). Cache được vì
 * nó keyed theo sub -- khác hẳn việc cache `OAuth2Client`, thứ không bao giờ nên
 * cache (xem `WorkspaceAuth.getAuthenticatedClient`).
 */
const _authBySub = new Map<string, WorkspaceAuth>()

/**
 * State cũng phải theo sub, không phải một biến chung. `getState()` là cửa gác
 * mọi domain tool (registry.ts) và là thứ `config(action="status")` báo ra: để
 * chung thì `setup_reset` của một người dùng sẽ khoá tool của người khác, và
 * trạng thái của người này lộ sang người kia.
 */
const _stateBySub = new Map<string, CredentialState>()

/** Bucket của request hiện tại. Ngoài mọi subject scope (stdio) = SINGLE_USER. */
function bucket(): string {
  return currentSubject() ?? SINGLE_USER
}

export function getState(): CredentialState {
  return _stateBySub.get(bucket()) ?? 'awaiting_setup'
}

export function getAuth(): WorkspaceAuth {
  const sub = bucket()
  let auth = _authBySub.get(sub)
  if (!auth) {
    auth = new WorkspaceAuth(BASE_SCOPES, sub === SINGLE_USER ? null : sub)
    _authBySub.set(sub, auth)
  }
  return auth
}

export async function resolveCredentialState(): Promise<CredentialState> {
  const sub = bucket()
  const auth = getAuth()
  const { accounts } = await auth.listAccounts()
  if (accounts.length > 0) {
    _stateBySub.set(sub, 'configured')
    return 'configured'
  }
  // Blob phẳng M1 vẫn tính là đã cấu hình: getAuthenticatedClient() sẽ nhận nó
  // về (hỏi Google lấy email) ở lần dùng đầu tiên. Chỉ tới đây mới dựng client,
  // vì đó là đường duy nhất có thể phải gọi mạng.
  try {
    await auth.getAuthenticatedClient()
    _stateBySub.set(sub, 'configured')
    return 'configured'
  } catch {
    _stateBySub.set(sub, 'awaiting_setup')
    return 'awaiting_setup'
  }
}

export async function resetState(): Promise<void> {
  // Qua getAuth(), KHÔNG qua một instance dựng sẵn: `config(action="setup_reset")`
  // phải xoá bucket của chính người gọi. Dùng instance chung thì một người dùng
  // remote vừa không xoá được credential của mình, vừa xoá mất bucket của người khác.
  await getAuth().clear()
  _stateBySub.set(bucket(), 'awaiting_setup')
}
