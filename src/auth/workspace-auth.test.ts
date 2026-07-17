import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
import { WorkspaceAuth } from './workspace-auth.js'

describe('WorkspaceAuth', () => {
  let testHomeDir: string

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    // Isolate PerPluginStore's LocalFsBackend from the real ~/.better-workspace-mcp/config.json.
    testHomeDir = mkdtempSync(join(tmpdir(), 'better-workspace-mcp-test-'))
    setHomeDirForTesting(testHomeDir)
  })

  afterEach(() => {
    setHomeDirForTesting(null)
    rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('builds an OAuth2Client with stored credentials', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens({ access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 })
    const client = await auth.getAuthenticatedClient()
    expect(client.credentials.access_token).toBe('at')
    expect(client.credentials.refresh_token).toBe('rt')
    await auth.clear()
  })

  it('throws a clear error when no token is stored', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.clear()
    await expect(auth.getAuthenticatedClient()).rejects.toThrow(/not configured/i)
  })

  it('computes expiry_date from expires_in when absent', async () => {
    const auth = new WorkspaceAuth(['openid'])
    const before = Date.now()
    // Google's raw token response: expires_in (relative seconds), no expiry_date.
    await auth.saveTokens({ access_token: 'a', refresh_token: 'r', expires_in: 3600 } as unknown as Parameters<
      WorkspaceAuth['saveTokens']
    >[0])
    const client = await auth.getAuthenticatedClient()
    expect(client.credentials.expiry_date).toBeGreaterThanOrEqual(before + 3600_000)
    expect(client.credentials.expiry_date).toBeLessThanOrEqual(Date.now() + 3600_000)
    await auth.clear()
  })

  it('uses a store plugin name without the -mcp suffix (avoids double -mcp on disk)', () => {
    expect(STORE_PLUGIN).toBe('better-workspace')
    expect(STORE_PLUGIN.endsWith('-mcp')).toBe(false)
  })
})
