import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { filesGet, mkdir, writeFile } = vi.hoisted(() => ({
  filesGet: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    promises: { ...actual.promises, mkdir, writeFile }
  }
})

vi.mock('googleapis', () => ({
  google: { drive: () => ({ files: { get: filesGet } }) }
}))

import { AuthManager } from '../auth/AuthManager.js'
import { PROJECT_ROOT } from '../utils/paths.js'
import { DriveService } from './DriveService.js'

const fileId = 'local-contract-file-id-12345'

describe('DriveService downloadFile local filesystem contract', () => {
  beforeEach(() => {
    filesGet.mockReset()
    mkdir.mockReset()
    writeFile.mockReset()
    mkdir.mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
    filesGet
      .mockResolvedValueOnce({
        data: { name: 'report.pdf', mimeType: 'application/pdf' }
      })
      .mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]).buffer })
  })

  async function download(localPath: string) {
    const service = new DriveService(new AuthManager(['scope']))
    return service.downloadFile({ fileId, localPath })
  }

  it('resolves a normal relative destination under PROJECT_ROOT in local stdio mode', async () => {
    const localPath = 'downloads/report.pdf'
    const expectedPath = path.resolve(PROJECT_ROOT, localPath)

    const result = await download(localPath)

    expect(writeFile).toHaveBeenCalledWith(expectedPath, expect.any(Buffer))
    expect(result.content[0].text).toContain(expectedPath)
  })

  it('keeps an explicit absolute destination unchanged in local stdio mode', async () => {
    const localPath = path.join(PROJECT_ROOT, 'downloads', 'report.pdf')

    await download(localPath)

    expect(writeFile).toHaveBeenCalledWith(localPath, expect.any(Buffer))
  })

  it('resolves local relative traversal with the existing local caller contract', async () => {
    const localPath = '../../outside-report.pdf'
    const expectedPath = path.resolve(PROJECT_ROOT, localPath)

    await download(localPath)

    expect(path.relative(PROJECT_ROOT, expectedPath).startsWith('..')).toBe(true)
    expect(writeFile).toHaveBeenCalledWith(expectedPath, expect.any(Buffer))
  })

  it('does not decode encoded traversal segments in the local caller contract', async () => {
    const localPath = '%2e%2e/%2e%2e/encoded-report.pdf'
    const expectedPath = path.resolve(PROJECT_ROOT, localPath)

    await download(localPath)

    expect(expectedPath).toContain('%2e%2e')
    expect(writeFile).toHaveBeenCalledWith(expectedPath, expect.any(Buffer))
  })
})
