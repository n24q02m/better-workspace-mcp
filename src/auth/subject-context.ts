/**
 * JWT `sub` của request hiện tại (chế độ HTTP remote).
 *
 * Lồng NGOÀI account-context: một tool call chạy trong hai lớp — sub (người
 * dùng nào, lấy từ Bearer JWT trong authScope) rồi account (Google account nào
 * của người đó, lấy từ tham số tool). Hai trục độc lập nên phải là hai storage
 * riêng, không gộp thành một object.
 *
 * mcp-core KHÔNG export sẵn subject context: doc của `RunHttpServerOptions.authScope`
 * (`transport/local-server.ts:96-102`) nói rõ consumer tự wrap request trong
 * AsyncLocalStorage. Đây là chỗ làm việc đó.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<{ sub: string }>()

export function runWithSubject<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ sub }, fn)
}

export function currentSubject(): string | undefined {
  return storage.getStore()?.sub
}
