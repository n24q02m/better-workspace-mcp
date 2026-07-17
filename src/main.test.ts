import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTransportMode } from './main.js'

// startServer/bootstrap are NOT invoked here -- stdio mode now runs a real
// OAuth setup (browser flow) when unconfigured, which this task must not
// trigger (Task 6 owns the real-flow test, with a real Google client). Only
// the pure helper is exercised.
describe('getTransportMode', () => {
  const originalEnv = process.env
  const originalArgv = process.argv

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
  })

  afterEach(() => {
    process.env = originalEnv
    process.argv = originalArgv
    vi.unstubAllEnvs()
  })

  it('defaults to stdio when no flag or env is set', () => {
    expect(getTransportMode({}, [])).toBe('stdio')
  })

  it('selects http via the --http flag', () => {
    expect(getTransportMode({}, ['--http'])).toBe('http')
  })

  it('does not match a flag that merely starts with --http', () => {
    expect(getTransportMode({}, ['--http-proxy'])).toBe('stdio')
  })

  it('selects http via MCP_TRANSPORT=http', () => {
    expect(getTransportMode({ MCP_TRANSPORT: 'http' }, [])).toBe('http')
  })

  it('selects http via TRANSPORT_MODE=http', () => {
    expect(getTransportMode({ TRANSPORT_MODE: 'http' }, [])).toBe('http')
  })

  it('reads current process.env / process.argv when no arguments are provided', () => {
    vi.stubEnv('TRANSPORT_MODE', 'http')
    expect(getTransportMode()).toBe('http')
  })
})
