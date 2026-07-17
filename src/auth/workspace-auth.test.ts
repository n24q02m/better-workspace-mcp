import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
