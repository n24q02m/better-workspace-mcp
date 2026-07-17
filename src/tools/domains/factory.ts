/**
 * Generic domain mega-tool factory. Every N+2 domain tool (docs, and the 9
 * more Task 7b appends) dispatches `action` to a vendored Service method the
 * same way -- this factory captures that dispatch once instead of each
 * domain hand-rolling it (see docs.ts before this refactor).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
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

export interface DomainRunInput {
  action: string
  account?: string
  [key: string]: unknown
}

export function makeDomainRun(
  ServiceClass: ServiceCtor | ServiceCtorNoAuth,
  actions: readonly string[],
  opts: { noAuth?: boolean } = {}
) {
  const svc = opts.noAuth
    ? new (ServiceClass as ServiceCtorNoAuth)()
    : new (ServiceClass as ServiceCtor)(new AuthManager(BASE_SCOPES))

  return function run(input: DomainRunInput): Promise<CallToolResult> {
    return withErrorHandling(async () => {
      const { action, account, ...params } = input
      if (!actions.includes(action)) {
        throw new WorkspaceMCPError(
          `Unknown action: ${action}`,
          'VALIDATION_ERROR',
          `Valid actions: ${actions.join(', ')}`
        )
      }
      // account is accepted but ignored in M1 (single-account; M2 wires per-account auth).
      void account
      const method = (svc as unknown as Record<string, ServiceMethod>)[action]
      return method(params)
    })()
  }
}
