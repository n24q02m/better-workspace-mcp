import { ChatService } from '../../vendored/services/ChatService.js'
import { makeDomainRun } from './factory.js'

export const CHAT_ACTIONS = [
  'listSpaces',
  'sendMessage',
  'findSpaceByName',
  'getMessages',
  'sendDm',
  'findDmByEmail',
  'listThreads',
  'setUpSpace'
] as const
export const chat = makeDomainRun(ChatService, CHAT_ACTIONS)
