/**
 * Generic domain mega-tool factory. Every N+2 domain tool (docs, and the 9
 * more Task 7b appends) dispatches `action` to a vendored Service method the
 * same way -- this factory captures that dispatch once instead of each
 * domain hand-rolling it (see docs.ts before this refactor).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { runWithAccount } from '../../auth/account-context.js'
import { BASE_SCOPES } from '../../constants.js'
import { AuthManager } from '../../vendored/auth/AuthManager.js'
import { WorkspaceMCPError, withErrorHandling } from '../helpers/errors.js'

// Vendored Service classes are constructed with an AuthManager (docs, drive,
// ...) or, like TimeService, with none at all (noAuth). Their instance
// methods have concrete param types (e.g. {documentId: string}), not
// `unknown` -- typed here as `object` and cast at the dispatch call site
// below, the same way the original hand-written docs.ts cast `svc` rather
// than trying to type the constructor's return shape as a method dictionary.
type ServiceCtor = new (auth: AuthManager) => object
type ServiceCtorNoAuth = new () => object
type ServiceMethod = (params: unknown) => Promise<CallToolResult>

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export function normalizePageSize(value: unknown, field: 'pageSize' | 'maxResults'): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new WorkspaceMCPError(
      `${field} must be an integer`,
      'VALIDATION_ERROR',
      `Use an integer from 1 to ${MAX_PAGE_SIZE}`
    )
  }
  return Math.min(Math.max(value, 1), MAX_PAGE_SIZE)
}

function normalizeBoundedParams(
  action: string,
  params: Record<string, unknown>,
  pagination: Record<string, 'pageSize' | 'maxResults'> | undefined
): Record<string, unknown> {
  const normalized = { ...params }
  const field = pagination?.[action]
  if (!field) return normalized
  normalized[field] = normalizePageSize(normalized[field], field)
  return normalized
}

export interface DomainRunInput {
  action: string
  account?: string
  [key: string]: unknown
}

export function makeDomainRun(
  ServiceClass: ServiceCtor | ServiceCtorNoAuth,
  actions: readonly string[],
  opts: {
    noAuth?: boolean
    pagination?: Record<string, 'pageSize' | 'maxResults'>
  } = {}
): (input: DomainRunInput) => Promise<CallToolResult> {
  const svc = opts.noAuth
    ? new (ServiceClass as ServiceCtorNoAuth)()
    : new (ServiceClass as ServiceCtor)(new AuthManager(BASE_SCOPES))

  return function run(input: DomainRunInput): Promise<CallToolResult> {
    return withErrorHandling(async () => {
      const { action, account, ...rawParams } = input
      if (!actions.includes(action)) {
        throw new WorkspaceMCPError(
          `Unknown action: ${action}`,
          'VALIDATION_ERROR',
          `Valid actions: ${actions.join(', ')}`
        )
      }
      const params = normalizeBoundedParams(action, rawParams, opts.pagination)
      const method = (svc as unknown as Record<string, ServiceMethod>)[action]
      // The vendored service is a singleton built at module load, and upstream's
      // getAuthenticatedClient() takes no arguments, so the account cannot ride
      // down as a parameter without editing vendored code. It travels in
      // AsyncLocalStorage instead; the AuthManager shim reads it back out.
      return runWithAccount(account, () => method(params))
    })()
  }
}
