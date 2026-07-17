import { DriveService } from '../../vendored/services/DriveService.js'
import { makeDomainRun } from './factory.js'

export const DRIVE_ACTIONS = [
  'findFolder',
  'createFolder',
  'search',
  'trashFile',
  'renameFile',
  'getComments',
  'moveFile',
  'downloadFile'
] as const
export const drive = makeDomainRun(DriveService, DRIVE_ACTIONS)
