/**
 * Better Workspace MCP Server -- Entry point
 *
 * Transport selection (M1):
 *  - stdio (default): one-shot Google OAuth setup on first run, MCP SDK
 *    StdioServerTransport directly. Single-account.
 *  - http: Milestone 3 (not yet implemented).
 */

export async function initServer() {
  const { startServer, getTransportMode } = await import('./main.js')
  await startServer(getTransportMode())
}
