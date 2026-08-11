import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { filesGet, filesList, mkdir, writeFile } = vi.hoisted(() => ({
  filesGet: vi.fn(),
  filesList: vi.fn(),
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
  google: { drive: () => ({ files: { get: filesGet, list: filesList } }) }
}))

import { AuthManager } from '../auth/AuthManager.js'
import { PROJECT_ROOT } from '../utils/paths.js'
import { DriveService } from './DriveService.js'

const fileId = 'local-contract-file-id-12345'

describe('DriveService downloadFile local filesystem contract', () => {
  beforeEach(() => {
    filesGet.mockReset()
    filesList.mockReset()
    mkdir.mockReset()
    writeFile.mockReset()
    mkdir.mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
    filesList.mockResolvedValue({ data: { files: [] } })
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

describe('DriveService search URL hostname validation', () => {
  beforeEach(() => {
    filesGet.mockReset()
    filesList.mockReset()
    filesList.mockResolvedValue({ data: { files: [] } })
  })

  it.each([
    'drive.google.com.attacker.example',
    'docs.google.com.attacker.example'
  ])('does not treat a URL with a forged %s hostname as a Google Drive URL', async (hostname) => {
    const query = `https://${hostname}/file/d/attacker-file-id-12345678901234567890`
    const service = new DriveService(new AuthManager(['scope']))

    await service.search({ query })

    expect(filesGet).not.toHaveBeenCalled()
    expect(filesList).toHaveBeenCalledWith(expect.objectContaining({
      q: `fullText contains '${query}'`
    }))
  })

  it.each([
    ['drive.google.com', 'drive-file-id-12345678901234567890'],
    ['docs.google.com', 'docs-file-id-12345678901234567890']
  ])('still treats the exact %s hostname as a Google Drive URL', async (hostname, fileId) => {
    const service = new DriveService(new AuthManager(['scope']))
    filesGet.mockReset()
    filesGet.mockResolvedValue({ data: { id: fileId, name: 'report.pdf' } })

    await service.search({ query: `https://${hostname}/file/d/${fileId}` })

    expect(filesGet).toHaveBeenCalledWith({
      fileId,
      fields: 'id, name, modifiedTime, viewedByMeTime, mimeType, parents',
      supportsAllDrives: true
    })
    expect(filesList).not.toHaveBeenCalled()
  })
})
