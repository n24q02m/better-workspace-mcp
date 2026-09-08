import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { MAX_PAGE_SIZE, makeDomainRun, normalizePageSize } from './factory.js'

class CaptureService {
  constructor(auth: unknown) {
    void auth
  }
  list = async (params: unknown): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(params) }]
  })

  write = async (params: unknown): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(params) }]
  })
}
function textOf(result: CallToolResult): string {
  const item = result.content[0]
  if (item.type !== 'text') throw new Error('expected text result')
  return item.text
}

describe('pagination contracts', () => {
  it('defaults and clamps bounded list inputs', () => {
    expect(normalizePageSize(undefined, 'pageSize')).toBe(20)
    expect(normalizePageSize(0, 'pageSize')).toBe(1)
    expect(normalizePageSize(-10, 'pageSize')).toBe(1)
    expect(normalizePageSize(101, 'pageSize')).toBe(MAX_PAGE_SIZE)
  })

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '20'])('rejects invalid %s', (value) => {
    expect(() => normalizePageSize(value, 'maxResults')).toThrow(/maxResults must be an integer/)
  })

  it('normalizes only the configured list action', async () => {
    const run = makeDomainRun(CaptureService, ['list', 'write'], {
      pagination: { list: 'pageSize' }
    })

    const listResult = await run({ action: 'list', pageSize: 500 })
    expect(JSON.parse(textOf(listResult))).toEqual({ pageSize: 100 })

    const writeResult = await run({ action: 'write', pageSize: 500 })
    expect(JSON.parse(textOf(writeResult))).toEqual({ pageSize: 500 })
  })
  it('rejects unknown actions before validating pagination fields', async () => {
    const run = makeDomainRun(CaptureService, ['list'], { pagination: { list: 'pageSize' } })
    await expect(run({ action: 'missing', pageSize: 1.5 })).rejects.toThrow(/Unknown action: missing/)
  })

  it('returns a validation error for invalid list input', async () => {
    const run = makeDomainRun(CaptureService, ['list'], { pagination: { list: 'pageSize' } })
    await expect(run({ action: 'list', pageSize: 1.5 })).rejects.toThrow(/pageSize must be an integer/)
  })
})
