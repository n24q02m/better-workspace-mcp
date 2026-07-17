/**
 * Custom error class for Workspace MCP operations
 */
export class WorkspaceMCPError extends Error {
  constructor(
    public message: string,
    public code: string,
    public suggestion?: string,
    public details?: any
  ) {
    super(message)
    this.name = 'WorkspaceMCPError'
  }

  toJSON() {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      suggestion: this.suggestion,
      details: this.details
    }
  }
}

/**
 * Sanitize error object to remove sensitive information
 */
function sanitizeErrorDetails(error: any): any {
  if (!error || typeof error !== 'object') return error

  // whitelist safe properties
  const safe: any = {
    message: error.message,
    name: error.name,
    code: error.code
  }

  // Add status if available (common in HTTP errors)
  if (error.status) safe.status = error.status
  if (error.response?.status) safe.status = error.response.status

  return safe
}

/**
 * Header names to redact whenever they appear inside an error/details object.
 * Compared case-insensitively against the actual property names so that
 * `Authorization`, `authorization`, `AUTHORIZATION`, `Proxy-Authorization`,
 * etc. are all stripped.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie'
])

/**
 * Remove sensitive headers from a headers-shaped object regardless of the
 * casing the upstream library happened to use. Google API client libraries
 * may surface `Authorization`, `authorization`, or `X-API-Key`.
 */
function redactHeaderMap(headers: any): void {
  if (!headers || typeof headers !== 'object') return
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      delete headers[key]
    }
  }
}

function stripSensitiveFields(obj: any, seen = new WeakSet()): void {
  if (!obj || typeof obj !== 'object') return
  if (seen.has(obj)) return
  seen.add(obj)

  delete obj.sensitive_token
  delete obj.internal_config
  delete obj.user_email

  // Strip authorization-style headers from the common error-shape locations
  // (response interceptors copy them onto multiple parent objects).
  redactHeaderMap(obj.headers)
  redactHeaderMap(obj._headers)
  if (obj.request) {
    redactHeaderMap(obj.request.headers)
    redactHeaderMap(obj.request._headers)
  }
  if (obj.config) {
    redactHeaderMap(obj.config.headers)
  }
  if (obj.response) {
    redactHeaderMap(obj.response.headers)
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      stripSensitiveFields(obj[key], seen)
    }
  }
}

/**
 * Map network-related errors
 */
function mapNetworkError(error: any): WorkspaceMCPError | null {
  if (!error || typeof error !== 'object') return null
  if (error.message?.includes('ECONNREFUSED') || error.message?.includes('ENOTFOUND')) {
    return new WorkspaceMCPError(
      'Cannot connect to the Google API',
      'NETWORK_ERROR',
      'Check your internet connection and try again'
    )
  }
  return null
}

/**
 * Map any error that already carries a `.code` (e.g. a Google API / gaxios
 * error, or a plain error object thrown before this module renders it into a
 * WorkspaceMCPError). Preserves the code so callers like retryWithBackoff can
 * branch on it; domain-specific friendlier messages get added here as
 * domains land (currently generic pass-through only).
 */
function mapCodedError(error: any): WorkspaceMCPError | null {
  if (!error || typeof error !== 'object') return null
  if (!error.code) return null
  return new WorkspaceMCPError(
    error.message || 'Unknown error occurred',
    String(error.code).toUpperCase(),
    'Check the error details and try again',
    sanitizeErrorDetails(error)
  )
}

/**
 * Map all other errors
 */
function mapGenericError(error: any): WorkspaceMCPError {
  if (!error || typeof error !== 'object') {
    return new WorkspaceMCPError('Unknown error occurred', 'UNKNOWN_ERROR', 'Please check your request and try again')
  }
  return new WorkspaceMCPError(
    error.message || 'Unknown error occurred',
    'UNKNOWN_ERROR',
    'Please check your request and try again',
    sanitizeErrorDetails(error)
  )
}

/**
 * Enhance a raw error with helpful, AI-readable context
 */
export function enhanceError(error: any): WorkspaceMCPError {
  // Already a WorkspaceMCPError — pass through unchanged
  if (error instanceof WorkspaceMCPError) return error

  // Explicitly strip sensitive fields recursively
  stripSensitiveFields(error)

  // Chain of responsibility: Network -> Coded -> Generic. Domain-specific
  // mappers (e.g. friendlier Google API error messages) get added here as
  // domains land.
  return mapNetworkError(error) || mapCodedError(error) || mapGenericError(error)
}

/**
 * Find the closest matching string from a list of valid options.
 * Uses Levenshtein-like similarity (simple character overlap).
 */
export function findClosestMatch(input: string, validOptions: string[]): string | null {
  if (!input || validOptions.length === 0) return null

  const lower = input.toLowerCase()
  let bestMatch: string | null = null
  let bestScore = 0

  // Pre-calculate input bigrams outside the loop to avoid redundant allocations
  const inputBigrams = new Set<string>()
  for (let i = 0; i < lower.length - 1; i++) inputBigrams.add(lower.slice(i, i + 2))

  for (const option of validOptions) {
    const optionLower = option.toLowerCase()
    // Check prefix match first
    if (optionLower.startsWith(lower) || lower.startsWith(optionLower)) {
      return option
    }
    // Simple bigram similarity
    const optionBigrams = new Set<string>()
    for (let i = 0; i < optionLower.length - 1; i++) optionBigrams.add(optionLower.slice(i, i + 2))

    let overlap = 0
    for (const b of inputBigrams) {
      if (optionBigrams.has(b)) overlap++
    }
    const score = (2 * overlap) / (inputBigrams.size + optionBigrams.size)
    if (score > bestScore && score > 0.4) {
      bestScore = score
      bestMatch = option
    }
  }

  return bestMatch
}

/**
 * Create AI-readable error message
 */
export function aiReadableMessage(error: WorkspaceMCPError): string {
  let message = `Error: ${error.message}`

  // Use explicit suggestion if present, otherwise fallback to suggestFixes()
  const suggestion = error.suggestion || suggestFixes(error).join('\n- ')
  if (suggestion) {
    message += `\n\nSuggestion: ${error.suggestion ? suggestion : `\n- ${suggestion}`}`
  }

  if (error.details) {
    message += `\n\nDetails: ${JSON.stringify(error.details, null, 2)}`
  }

  return message
}

/**
 * Per-code suggestion overrides. Empty in M1 (no domain-specific error codes
 * yet) -- domains add entries here as they land.
 */
const _ERROR_SUGGESTIONS_MAP: Record<string, string[]> = {}

const _DEFAULT_SUGGESTIONS = ['Review request parameters', 'Try again in a few moments']

/**
 * Suggest fixes based on error code
 */
export function suggestFixes(error: WorkspaceMCPError): string[] {
  return _ERROR_SUGGESTIONS_MAP[error.code] || _DEFAULT_SUGGESTIONS
}

/**
 * Wrap async function with error handling
 */
export function withErrorHandling<Args extends unknown[], Return>(
  fn: (...args: Args) => Promise<Return>
): (...args: Args) => Promise<Return> {
  return async (...args: Args): Promise<Return> => {
    try {
      return await fn(...args)
    } catch (error) {
      throw enhanceError(error)
    }
  }
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    initialDelay?: number
    maxDelay?: number
    backoffMultiplier?: number
  } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 10000, backoffMultiplier = 2 } = options

  let lastError: any
  let delay = initialDelay

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: any) {
      lastError = error

      // Don't retry on certain errors
      if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') {
        throw enhanceError(error)
      }

      // Last attempt
      if (attempt === maxRetries) {
        break
      }

      // Wait with exponential backoff
      await new Promise((resolve) => globalThis.setTimeout(resolve, delay))
      delay = Math.min(delay * backoffMultiplier, maxDelay)
    }
  }

  throw enhanceError(lastError)
}
