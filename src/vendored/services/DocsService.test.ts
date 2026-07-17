import { describe, it, expect, vi } from 'vitest'

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

  it('imports and constructs without crashing (no gemini-extension.json marker needed)', async () => {
    const mod = await import('./DocsService.js')
    expect(mod.DocsService).toBeTypeOf('function')
  })
})
