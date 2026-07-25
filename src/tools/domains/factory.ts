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
      const method = (svc as unknown as Record<string, ServiceMethod>)[action]
      // The vendored service is a singleton built at module load, and upstream's
      // getAuthenticatedClient() takes no arguments, so the account cannot ride
      // down as a parameter without editing vendored code. It travels in
      // AsyncLocalStorage instead; the AuthManager shim reads it back out.
      return runWithAccount(account, () => method(params))
    })()
  }
}
