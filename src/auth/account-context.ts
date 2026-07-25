/**
 * Account đang được chọn cho request hiện tại.
 *
 * Vì các service vendored được khởi tạo singleton lúc module-load (xem
 * factory.ts) và chữ ký upstream `getAuthenticatedClient()` không nhận tham
 * số, account không thể đi xuống bằng đường tham số mà không sửa code
 * vendored. AsyncLocalStorage giữ nguyên chữ ký đó.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface AccountScope {
  account?: string
}

const storage = new AsyncLocalStorage<AccountScope>()

export function runWithAccount<T>(account: string | undefined, fn: () => Promise<T>): Promise<T> {
  return storage.run({ account }, fn)
}

export function currentAccount(): string | undefined {
  return storage.getStore()?.account
}
