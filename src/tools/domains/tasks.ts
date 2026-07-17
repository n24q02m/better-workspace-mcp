import { TasksService } from '../../vendored/services/TasksService.js'
import { makeDomainRun } from './factory.js'

export const TASKS_ACTIONS = [
  'listTaskLists',
  'listTasks',
  'createTask',
  'updateTask',
  'completeTask',
  'deleteTask'
] as const
export const tasks = makeDomainRun(TasksService, TASKS_ACTIONS)
