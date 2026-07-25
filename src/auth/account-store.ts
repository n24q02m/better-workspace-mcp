/**
 * Nhiều Google account trong MỘT blob mã hoá.
 *
 * PerPluginStore chỉ có đúng một credKey cho mỗi (plugin, sub) — xem
 * per-plugin-store.ts:74-82 — nên layout "một key mỗi account" mà spec §4.2
 * mô tả không dùng được. Gộp vào một blob cũng khiến mỗi lần ghi là atomic:
 * `accounts` và `primary` không bao giờ lệch nhau.
 */
import { PerPluginStore } from '@n24q02m/mcp-core/storage'
import { STORE_PLUGIN } from '../constants.js'

export interface AccountRecord {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  scope?: string
  token_type?: string
  id_token?: string
}

export interface AccountsBlob {
  version: 2
  accounts: Record<string, AccountRecord>
  primary: string
}

/** Đọc claim `email` từ id_token. Không xác thực chữ ký: token do chính Google trả về trong luồng đã hoàn tất. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (typeof idToken !== 'string') return undefined
  const payload = idToken.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    return typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** Blob phẳng của M1: token nằm ngay ở cấp trên, chưa có `version`. */
export function isLegacyBlob(raw: Record<string, unknown> | null): boolean {
  return raw !== null && raw.version === undefined && typeof raw.access_token === 'string'
}

const normalize = (email: string) => email.trim().toLowerCase()

export class AccountStore {
  private store = new PerPluginStore(STORE_PLUGIN)

  /**
   * Trả blob v2. Nếu trên đĩa còn là blob phẳng M1 thì tự migrate KHI suy ra
   * được email từ id_token; nếu không suy ra được thì trả null và để nguyên
   * blob cũ (không được làm mất token của người dùng) — Task 3 sẽ hỏi Google
   * lấy email rồi gọi `put`.
   */
  async load(): Promise<AccountsBlob | null> {
    const raw = await this.store.load()
    if (raw === null) return null
    if (!isLegacyBlob(raw)) {
      const blob = raw as unknown as AccountsBlob
      return blob.version === 2 && blob.accounts ? blob : null
    }
    const legacy = raw as unknown as AccountRecord
    const email = emailFromIdToken(legacy.id_token)
    if (!email) return null
    const migrated: AccountsBlob = { version: 2, accounts: { [email]: legacy }, primary: email }
    await this.store.save(migrated as unknown as Record<string, unknown>)
    return migrated
  }

  /** Blob phẳng M1 chưa migrate được, hoặc null. */
  async loadLegacy(): Promise<AccountRecord | null> {
    const raw = await this.store.load()
    return isLegacyBlob(raw) ? (raw as unknown as AccountRecord) : null
  }

  async put(email: string, record: AccountRecord, opts: { makePrimary?: boolean } = {}): Promise<void> {
    const key = normalize(email)
    const existing = (await this.load()) ?? { version: 2 as const, accounts: {}, primary: key }
    const accounts = { ...existing.accounts, [key]: record }
    const primary = opts.makePrimary || !existing.accounts[existing.primary] ? key : existing.primary
    await this.store.save({ version: 2, accounts, primary } as unknown as Record<string, unknown>)
  }

  /** `email` không truyền = primary. Account lạ trả null (KHÔNG âm thầm rơi về primary). */
  async get(email?: string): Promise<{ email: string; record: AccountRecord } | null> {
    const blob = await this.load()
    if (!blob) return null
    const key = email ? normalize(email) : blob.primary
    const record = blob.accounts[key]
    return record ? { email: key, record } : null
  }

  async list(): Promise<{ accounts: string[]; primary: string | null }> {
    const blob = await this.load()
    if (!blob) return { accounts: [], primary: null }
    return { accounts: Object.keys(blob.accounts).sort(), primary: blob.primary }
  }

  async remove(email: string): Promise<{ removed: boolean; newPrimary: string | null }> {
    const blob = await this.load()
    if (!blob) return { removed: false, newPrimary: null }
    const key = normalize(email)
    if (!blob.accounts[key]) return { removed: false, newPrimary: blob.primary }
    const accounts = { ...blob.accounts }
    delete accounts[key]
    const remaining = Object.keys(accounts)
    if (remaining.length === 0) {
      await this.store.clear()
      return { removed: true, newPrimary: null }
    }
    const primary = blob.primary === key ? (remaining[0] as string) : blob.primary
    await this.store.save({ version: 2, accounts, primary } as unknown as Record<string, unknown>)
    return { removed: true, newPrimary: primary }
  }

  async setPrimary(email: string): Promise<void> {
    const blob = await this.load()
    const key = normalize(email)
    if (!blob?.accounts[key]) {
      throw new Error(`Account ${key} is not configured.`)
    }
    await this.store.save({ ...blob, primary: key } as unknown as Record<string, unknown>)
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }
}
