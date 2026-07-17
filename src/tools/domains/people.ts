import { PeopleService } from '../../vendored/services/PeopleService.js'
import { makeDomainRun } from './factory.js'

export const PEOPLE_ACTIONS = ['getUserProfile', 'getMe', 'getUserRelations'] as const
export const people = makeDomainRun(PeopleService, PEOPLE_ACTIONS)
