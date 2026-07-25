import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPackageVersion } from './version.js'

describe('getPackageVersion', () => {
  it('reports the version declared in package.json', () => {
    // Đọc package.json qua process.cwd() -- một đường phân giải KHÁC với đường
    // của implementation (import.meta.url), nên test không pass chỉ vì cả hai
    // sai giống nhau. Và KHÔNG assert một chuỗi hằng: PSR bump package.json mỗi
    // lần release, hằng số trong test sẽ mục ngay sau lần release kế.
    const declared = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string })
      .version
    expect(getPackageVersion()).toBe(declared)
  })

  it('returns a non-empty version string', () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
