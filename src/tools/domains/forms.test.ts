import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock() factories are hoisted above regular const declarations, so the
// mocks referenced inside must be created via vi.hoisted() to avoid a
// temporal-dead-zone error.
const { getMock, createMock, mockMethods, constructed } = vi.hoisted(() => {
  const getMock = vi.fn()
  const createMock = vi.fn()
  // makeDomainRun builds the service ONCE at module load and hands it the
  // AuthManager. Capturing that instance is what lets the account-plumbing
  // tests below drive the real shim instead of asserting against a mock.
  const constructed: { auth?: { getAuthenticatedClient: () => Promise<unknown> } } = {}
  return { getMock, createMock, mockMethods: { get: getMock, create: createMock }, constructed }
})

vi.mock('../../services/FormsService.js', () => ({
  // `new` requires a real function (not an arrow function) as the implementation.
  FormsService: vi.fn().mockImplementation(function FormsServiceMock(auth: {
    getAuthenticatedClient: () => Promise<unknown>
  }) {
    constructed.auth = auth
    return mockMethods
  })
}))

// NOTE: AuthManager is deliberately NOT mocked -- its shim is what reads the
// per-request account out of AsyncLocalStorage, so mocking it away would make
// the account tests below pass no matter how the dispatch is wired.

import { getAuth } from '../../auth/credential-state.js'
import { FORMS_ACTIONS, forms } from './forms.js'

/** Records the account each getAuthenticatedClient() call resolves to. */
function recordResolvedAccounts(): Array<string | undefined> {
  const seen: Array<string | undefined> = []
  vi.spyOn(getAuth(), 'getAuthenticatedClient').mockImplementation(async (account?: string) => {
    seen.push(account)
    return {} as never
  })
  getMock.mockImplementation(async () => {
    await constructed.auth?.getAuthenticatedClient()
    return { content: [{ type: 'text', text: 'ok' }] }
  })
  return seen
}

describe('forms mega-tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes the 5 FormsService methods as actions', () => {
    expect(FORMS_ACTIONS).toEqual(['create', 'get', 'batchUpdate', 'listResponses', 'getResponse'])
  })

  it('names only methods the real FormsService implements', async () => {
    // Bypasses the module mock above: a typo in FORMS_ACTIONS would otherwise
    // only surface at runtime, as "Unknown action" for an action we advertise.
    const actual = await vi.importActual<typeof import('../../services/FormsService.js')>(
      '../../services/FormsService.js'
    )
    const real = new actual.FormsService({ getAuthenticatedClient: async () => ({}) } as never) as unknown as Record<
      string,
      unknown
    >

    for (const action of FORMS_ACTIONS) {
      expect(typeof real[action], `FormsService.${action}`).toBe('function')
    }
  })

  it('dispatches to the matching FormsService method and returns its result unchanged', async () => {
    const svcResult = { content: [{ type: 'text', text: '{"formId":"f1"}' }] }
    getMock.mockResolvedValue(svcResult)

    const result = await forms({ action: 'get', formId: 'f1' })

    expect(getMock).toHaveBeenCalledWith({ formId: 'f1' })
    expect(result).toBe(svcResult)
  })

  it('forwards all non-action, non-account params to the method', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    await forms({ action: 'create', title: 'Survey', documentTitle: 'Q3', account: 'work@example.com' })

    // account selects credentials; it is not a service param.
    expect(createMock).toHaveBeenCalledWith({ title: 'Survey', documentTitle: 'Q3' })
  })

  it('throws a WorkspaceMCPError listing valid actions for an unknown action', async () => {
    await expect(forms({ action: 'listForms' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Unknown action: listForms',
      suggestion: `Valid actions: ${FORMS_ACTIONS.join(', ')}`
    })
  })

  it('passes the account from the tool input down to credential resolution', async () => {
    const seen = recordResolvedAccounts()

    await forms({ action: 'get', account: 'work@example.com', formId: 'f1' })

    expect(seen).toEqual(['work@example.com'])
  })

  it('keeps concurrent calls on their own account', async () => {
    const seen = recordResolvedAccounts()

    await Promise.all([
      forms({ action: 'get', account: 'a@example.com', formId: 'f1' }),
      forms({ action: 'get', account: 'b@example.com', formId: 'f1' }),
      forms({ action: 'get', formId: 'f1' })
    ])

    expect(seen.sort()).toEqual(['a@example.com', 'b@example.com', undefined])
  })
})
