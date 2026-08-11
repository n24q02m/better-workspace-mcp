import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER_METADATA = JSON.parse(readFileSync(resolve(__dirname, '..', 'server.json'), 'utf8')) as {
  description?: unknown
}

describe('MCP Registry metadata', () => {
  it('keeps the server description within the registry limit', () => {
    expect(typeof SERVER_METADATA.description).toBe('string')
    expect((SERVER_METADATA.description as string).length).toBeLessThanOrEqual(100)
  })
})
