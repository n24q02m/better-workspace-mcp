import { TimeService } from '../../vendored/services/TimeService.js'
import { makeDomainRun } from './factory.js'

// TimeService takes no auth (local date/time helpers) — factory noAuth:true.
export const TIME_ACTIONS = ['getCurrentDate', 'getCurrentTime', 'getTimeZone'] as const
export const time = makeDomainRun(TimeService, TIME_ACTIONS, { noAuth: true })
