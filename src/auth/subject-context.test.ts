import { describe, expect, it } from 'vitest'
import { currentSubject, runWithSubject } from './subject-context.js'

describe('subject-context', () => {
  it('returns undefined outside any scope', () => {
    expect(currentSubject()).toBeUndefined()
  })

  it('exposes the sub inside the scope and restores after', async () => {
    expect(await runWithSubject('sub-1', async () => currentSubject())).toBe('sub-1')
    expect(currentSubject()).toBeUndefined()
  })

  it('keeps concurrent subjects isolated', async () => {
    const slow = runWithSubject('slow', async () => {
      await new Promise((r) => setTimeout(r, 20))
      return currentSubject()
    })
    const fast = runWithSubject('fast', async () => currentSubject())
    expect(await fast).toBe('fast')
    expect(await slow).toBe('slow')
  })

  it('nests inside an account scope without either losing its value', async () => {
    const { runWithAccount, currentAccount } = await import('./account-context.js')
    const seen = await runWithSubject('sub-1', async () =>
      runWithAccount('a@example.com', async () => ({ sub: currentSubject(), account: currentAccount() }))
    )
    expect(seen).toEqual({ sub: 'sub-1', account: 'a@example.com' })
  })
})
