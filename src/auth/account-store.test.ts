import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/mcp-core/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
import { AccountStore, emailFromIdToken, isLegacyBlob } from './account-store.js'

// id_token là JWT không cần chữ ký hợp lệ ở đây: chỉ payload được đọc.
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

const REC = { access_token: 'at', refresh_token: 'rt', expiry_date: 4_000_000_000_000 }

describe('emailFromIdToken', () => {
  it('reads the email claim', () => {
    expect(emailFromIdToken(fakeIdToken({ sub: '1', email: 'A@Example.com' }))).toBe('a@example.com')
  })
  it('returns undefined for a token without an email claim', () => {
    expect(emailFromIdToken(fakeIdToken({ sub: '1' }))).toBeUndefined()
  })
  it('returns undefined for undefined or malformed input', () => {
    expect(emailFromIdToken(undefined)).toBeUndefined()
    expect(emailFromIdToken('not-a-jwt')).toBeUndefined()
    expect(emailFromIdToken('a.!!!.c')).toBeUndefined()
  })
})

describe('isLegacyBlob', () => {
  it('detects the flat M1 shape', () => {
    expect(isLegacyBlob({ access_token: 'at' })).toBe(true)
  })
  it('rejects the v2 shape and null', () => {
    expect(isLegacyBlob({ version: 2, accounts: {}, primary: '' })).toBe(false)
    expect(isLegacyBlob(null)).toBe(false)
  })
})

describe('AccountStore', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bws-accounts-test-'))
    setHomeDirForTesting(home)
  })
  afterEach(() => {
    setHomeDirForTesting(null)
    rmSync(home, { recursive: true, force: true })
  })

  it('returns null before anything is stored', async () => {
    expect(await new AccountStore().load()).toBeNull()
    expect(await new AccountStore().get()).toBeNull()
  })

  it('stores the first account and makes it primary automatically', async () => {
    const store = new AccountStore()
    await store.put('First@Example.com', REC)
    expect(await store.list()).toEqual({ accounts: ['first@example.com'], primary: 'first@example.com' })
    const got = await store.get()
    expect(got?.email).toBe('first@example.com')
    expect(got?.record.access_token).toBe('at')
  })

  it('keeps the existing primary when a second account is added without makePrimary', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await store.put('two@example.com', { ...REC, access_token: 'at2' })
    expect((await store.list()).primary).toBe('one@example.com')
    expect((await store.get('two@example.com'))?.record.access_token).toBe('at2')
  })

  it('switches primary when makePrimary is set', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await store.put('two@example.com', REC, { makePrimary: true })
    expect((await store.list()).primary).toBe('two@example.com')
  })

  it('resolves an unknown account to null rather than falling back to primary', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    expect(await store.get('nobody@example.com')).toBeNull()
  })

  it('removes an account and promotes a remaining one when the primary goes away', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await store.put('two@example.com', REC)
    expect(await store.remove('one@example.com')).toEqual({ removed: true, newPrimary: 'two@example.com' })
    expect((await store.list()).primary).toBe('two@example.com')
  })

  it('clears the blob when the last account is removed', async () => {
    const store = new AccountStore()
    await store.put('only@example.com', REC)
    expect(await store.remove('only@example.com')).toEqual({ removed: true, newPrimary: null })
    expect(await store.load()).toBeNull()
  })

  it('reports removed:false for an account that was never there', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    expect(await store.remove('ghost@example.com')).toEqual({ removed: false, newPrimary: 'one@example.com' })
  })

  it('refuses to set primary to an unknown account', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await expect(store.setPrimary('ghost@example.com')).rejects.toThrow(/not configured/i)
  })

  it('migrates a flat M1 blob in place when it carries an id_token with an email', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ ...REC, id_token: fakeIdToken({ email: 'legacy@example.com' }) })
    const store = new AccountStore()
    expect(await store.load()).toEqual({
      version: 2,
      accounts: { 'legacy@example.com': expect.objectContaining({ access_token: 'at' }) },
      primary: 'legacy@example.com'
    })
    // migration được ghi lại xuống đĩa, không phải chỉ trong bộ nhớ
    expect(isLegacyBlob(await new PerPluginStore(STORE_PLUGIN).load())).toBe(false)
  })

  it('leaves a flat blob untouched and exposes it via loadLegacy when the email cannot be derived', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ ...REC })
    const store = new AccountStore()
    expect(await store.load()).toBeNull()
    expect((await store.loadLegacy())?.access_token).toBe('at')
    expect(isLegacyBlob(await new PerPluginStore(STORE_PLUGIN).load())).toBe(true)
  })

  it('refuses to overwrite an unadopted legacy blob instead of losing its tokens', async () => {
    // Blob phẳng M1 không có id_token -> load() trả null, nhưng dữ liệu vẫn ở đó.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
    const store = new AccountStore()

    await expect(store.put('new@example.com', REC)).rejects.toThrow(/older single-account layout/i)

    // Token cũ còn nguyên, không bị ghi đè.
    expect((await store.loadLegacy())?.access_token).toBe('legacy-at')
    expect((await store.loadLegacy())?.refresh_token).toBe('legacy-rt')
  })

  describe('adoptLegacy', () => {
    it('turns the flat blob into a v2 blob under the given email, keeping its tokens', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()

      expect(await store.adoptLegacy('Adopted@Example.com')).toMatchObject({ access_token: 'legacy-at' })

      expect(await store.load()).toEqual({
        version: 2,
        accounts: {
          'adopted@example.com': expect.objectContaining({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
        },
        primary: 'adopted@example.com'
      })
      expect(isLegacyBlob(await new PerPluginStore(STORE_PLUGIN).load())).toBe(false)
      expect(await store.loadLegacy()).toBeNull()
    })

    it('unblocks put() -- the guard only fires while the legacy blob is unadopted', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()

      await store.adoptLegacy('adopted@example.com')
      await store.put('new@example.com', REC)

      expect((await store.list()).accounts).toEqual(['adopted@example.com', 'new@example.com'])
      // adoption giữ ngôi primary, thêm account mới không cướp nó
      expect((await store.list()).primary).toBe('adopted@example.com')
    })

    it('returns null when there is no flat blob to adopt', async () => {
      const store = new AccountStore()
      expect(await store.adoptLegacy('nobody@example.com')).toBeNull()

      await store.put('one@example.com', REC)
      expect(await store.adoptLegacy('one@example.com')).toBeNull()
      // blob v2 đang có không bị adoptLegacy làm hỏng
      expect((await store.list()).accounts).toEqual(['one@example.com'])
    })
  })
})
