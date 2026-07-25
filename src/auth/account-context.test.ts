import { describe, expect, it } from 'vitest'
import { currentAccount, runWithAccount } from './account-context.js'

describe('account-context', () => {
  it('returns undefined outside any scope', () => {
    expect(currentAccount()).toBeUndefined()
  })

  it('exposes the account inside the scope and restores after', async () => {
    const inside = await runWithAccount('a@example.com', async () => currentAccount())
    expect(inside).toBe('a@example.com')
    expect(currentAccount()).toBeUndefined()
  })

  it('keeps concurrent scopes isolated', async () => {
    const slow = runWithAccount('slow@example.com', async () => {
      await new Promise((r) => setTimeout(r, 20))
      return currentAccount()
    })
    const fast = runWithAccount('fast@example.com', async () => currentAccount())
    expect(await fast).toBe('fast@example.com')
    expect(await slow).toBe('slow@example.com')
  })

  it('lets an inner scope shadow an outer one', async () => {
    const seen = await runWithAccount('outer@example.com', async () =>
      runWithAccount('inner@example.com', async () => currentAccount())
    )
    expect(seen).toBe('inner@example.com')
  })

  it('treats an explicit undefined as "no account selected"', async () => {
    const seen = await runWithAccount(undefined, async () => currentAccount())
    expect(seen).toBeUndefined()
  })
})
