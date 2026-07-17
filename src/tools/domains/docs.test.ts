import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock() factories are hoisted above regular const declarations, so the
// mocks referenced inside must be created via vi.hoisted() to avoid a
// temporal-dead-zone error.
const { getTextMock, createMock, mockMethods } = vi.hoisted(() => {
  const getTextMock = vi.fn()
  const createMock = vi.fn()
  return { getTextMock, createMock, mockMethods: { getText: getTextMock, create: createMock } }
})

vi.mock('../../vendored/services/DocsService.js', () => ({
  // `new` requires a real function (not an arrow function) as the implementation.
  DocsService: vi.fn().mockImplementation(function DocsServiceMock() {
    return mockMethods
  })
}))

vi.mock('../../vendored/auth/AuthManager.js', () => ({
  AuthManager: vi.fn()
}))

import { DOCS_ACTIONS, docs } from './docs.js'

describe('docs mega-tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes the 6 DocsService methods as actions', () => {
    expect(DOCS_ACTIONS).toEqual(['getText', 'create', 'writeText', 'getSuggestions', 'replaceText', 'formatText'])
  })

  it('dispatches to the matching DocsService method and returns its result unchanged', async () => {
    const svcResult = { content: [{ type: 'text', text: 'hello' }] }
    getTextMock.mockResolvedValue(svcResult)

    const result = await docs({ action: 'getText', documentId: 'doc-1' })

    expect(getTextMock).toHaveBeenCalledWith({ documentId: 'doc-1' })
    expect(result).toBe(svcResult)
  })

  it('passes an isError result through unchanged (no re-wrapping)', async () => {
    const svcResult = { content: [{ type: 'text', text: '{"error":"boom"}' }], isError: true }
    getTextMock.mockResolvedValue(svcResult)

    const result = await docs({ action: 'getText', documentId: 'doc-1' })

    expect(result).toBe(svcResult)
  })

  it('accepts and ignores the account param (M1 single-account)', async () => {
    getTextMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    await docs({ action: 'getText', documentId: 'doc-1', account: 'someone@example.com' })

    expect(getTextMock).toHaveBeenCalledWith({ documentId: 'doc-1' })
  })

  it('forwards all non-action, non-account params to the method', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    await docs({ action: 'create', title: 'New Doc', content: 'body text' })

    expect(createMock).toHaveBeenCalledWith({ title: 'New Doc', content: 'body text' })
  })

  it('throws a WorkspaceMCPError listing valid actions for an unknown action', async () => {
    await expect(docs({ action: 'bogus' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Unknown action: bogus',
      suggestion: `Valid actions: ${DOCS_ACTIONS.join(', ')}`
    })
  })
})
