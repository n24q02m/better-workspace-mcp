// Shim (ours) for upstream utils/logger — logs to stderr (MCP convention:
// stdout is the protocol channel), gated off by default. Upstream wrote to
// <project>/logs/server.log via PROJECT_ROOT; no file I/O here, so this no
// longer needs to import ../utils/paths.
let isLoggingEnabled = false

export function setLoggingEnabled(enabled: boolean): void {
  isLoggingEnabled = enabled
}

export function logToFile(message: string): void {
  if (!isLoggingEnabled) {
    return
  }
  process.stderr.write(`[better-workspace-mcp] ${message}\n`)
}
