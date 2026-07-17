import { describe, it, expect, vi } from 'vitest'

// Isolate the vendored logger's project-root discovery: upstream's paths.ts
// walks the filesystem looking for `gemini-extension.json` (a Gemini CLI
// extension marker file that will never exist in this repo) and throws at
// import time if not found. Mocking PROJECT_ROOT lets logger.ts/IdUtils.ts/
// GaxiosConfig.ts load unmodified — logToFile stays a no-op (isLoggingEnabled
// defaults to false), so nothing actually touches the filesystem.
vi.mock('../utils/paths', () => ({ PROJECT_ROOT: '/mock-project-root' }))

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))
// Mock googleapis to intercept the Docs API call DocsService.getText makes.
const documentsGet = vi.fn().mockResolvedValue({ data: { title: 'Untitled', body: { content: [] }, tabs: [] } })
vi.mock('googleapis', () => ({
  google: { docs: () => ({ documents: { get: documentsGet } }) }
  // keep the Auth type import happy (type-only, erased at runtime)
}))

import { DocsService } from './DocsService.js'
import { AuthManager } from '../auth/AuthManager.js'

describe('vendored DocsService over the shim', () => {
  it('getText routes through the shim to docs.documents.get', async () => {
    const svc = new DocsService(new AuthManager(['scope']))
    const res = await svc.getText({ documentId: 'doc1' })
    expect(documentsGet).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc1', includeTabsContent: true })
    )
    expect(res.content[0].type).toBe('text')
  })
})
