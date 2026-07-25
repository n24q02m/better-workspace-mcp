/**
 * Version của package, đọc lúc chạy từ `package.json`.
 *
 * Module riêng vì CẢ HAI transport cần nó: stdio (`main.ts`) và http
 * (`transports/http.ts`). Để hàm này nằm private trong `main.ts` thì http chỉ
 * còn hai lựa chọn tệ -- hardcode một chuỗi (nó đã từng báo `'0.0.0'` trong khi
 * stdio báo version thật), hoặc import ngược `http.ts` -> `main.ts` và tạo vòng
 * phụ thuộc với chính module đang dynamic-import nó.
 *
 * Đường phân giải tính từ chính file này. Trong artifact ship thật (bundle
 * `bin/cli.mjs`, esbuild giữ `import.meta.url` trỏ tới bundle) thì `..` là gốc
 * repo/package -- đúng chỗ có `package.json`. PSR ghi version vào file đó lúc
 * release, nên KHÔNG được thay bằng hằng số.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
