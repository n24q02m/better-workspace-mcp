import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))
// Mock googleapis to intercept the Sheets reads SheetsService.getText makes.
const spreadsheetsGet = vi.fn()
const valuesGet = vi.fn()
const valuesBatchGet = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    sheets: () => ({
      spreadsheets: { get: spreadsheetsGet, values: { get: valuesGet, batchGet: valuesBatchGet } }
    })
  }
}))

import { SheetsService } from './SheetsService.js'
import { AuthManager } from '../auth/AuthManager.js'

const metadataWithTabs = (titles: string[]) => ({
  data: { properties: { title: 'Book' }, sheets: titles.map((title) => ({ properties: { title } })) }
})

const rowPerRange = async ({ range }: { range: string }) => ({ data: { values: [[`${range} row`]] } })

const getText = (args: { spreadsheetId: string; format?: 'text' | 'csv' | 'json' }) =>
  new SheetsService(new AuthManager(['scope'])).getText(args).then((res) => res.content[0].text)

describe('vendored SheetsService.getText tab reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads every tab in a single batchGet when the batch succeeds', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockResolvedValue({
      data: { valueRanges: [{ values: [['a1', 'a2']] }, { values: [['b1']] }] }
    })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).toHaveBeenCalledTimes(1)
    expect(valuesBatchGet).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      ranges: ["'Alpha'", "'Beta'"]
    })
    expect(valuesGet).not.toHaveBeenCalled()
    expect(text).toContain('Sheet Name: Alpha\na1 | a2')
    expect(text).toContain('Sheet Name: Beta\nb1')
  })

  it('renders a tab the batch returned empty as an empty sheet, not an error', async () => {
    // batchGet omits `values` entirely for a range with no data.
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ range: "'Alpha'" }] } })

    expect(await getText({ spreadsheetId: 'sheet-1' })).toContain('Sheet Name: Alpha\n(Empty sheet)')
  })

  it('falls back to per-tab reads and keeps partial success when the batch rejects', async () => {
    // batchGet is all-or-nothing: one unreadable range loses every tab, which is
    // why the fallback exists. 3 tabs, 1 broken -> still 2 tabs of real data.
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Broken', 'Gamma']))
    valuesBatchGet.mockRejectedValue(new Error('Unable to parse range'))
    valuesGet.mockImplementation(async (params: { range: string }) => {
      if (params.range === "'Broken'") throw new Error('boom')
      return rowPerRange(params)
    })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledTimes(3)
    expect(text).toContain("Sheet Name: Alpha\n'Alpha' row")
    expect(text).toContain('Sheet Name: Broken\n(Error reading sheet)')
    expect(text).toContain("Sheet Name: Gamma\n'Gamma' row")
  })

  it('drops only the unreadable tab from json output', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Broken']))
    valuesBatchGet.mockRejectedValue(new Error('Unable to parse range'))
    valuesGet.mockImplementation(async (params: { range: string }) => {
      if (params.range === "'Broken'") throw new Error('boom')
      return { data: { values: [['a1']] } }
    })

    const parsed = JSON.parse(await getText({ spreadsheetId: 'sheet-1', format: 'json' }))
    expect(parsed).toEqual({ Alpha: [['a1']] })
  })

  it('falls back rather than mis-mapping when batchGet returns the wrong number of ranges', async () => {
    // Tabs are matched to results by index, so a short response must not shift
    // Beta's rows onto Alpha (or hand Beta an empty sheet).
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a1']] }] } })
    valuesGet.mockImplementation(rowPerRange)

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledTimes(2)
    expect(text).toContain("Sheet Name: Alpha\n'Alpha' row")
    expect(text).toContain("Sheet Name: Beta\n'Beta' row")
  })

  it('escapes a quote in a tab name instead of building an unparseable range', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(["It's here"]))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['x']] }] } })

    await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      ranges: ["'It''s here'"]
    })
  })

  it('reads nothing and does not crash on a spreadsheet with no tabs', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs([]))

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).not.toHaveBeenCalled()
    expect(valuesGet).not.toHaveBeenCalled()
    expect(text).toBe('Spreadsheet Title: Book')
  })
})
