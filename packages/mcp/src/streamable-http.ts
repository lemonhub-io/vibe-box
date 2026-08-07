import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Wrap an MCP server factory in a fetch handler that speaks the MCP
 * streamable HTTP transport.
 *
 * The transport runs in stateless mode: every request builds a fresh
 * transport and server, connects them, and processes one request.
 * That matches the SDK's constraint that a stateless transport must
 * never be reused across requests, and it makes the handler safe on
 * a Durable Object, where an instance (and any in-memory session
 * state) can be evicted between requests.
 *
 * The factory is called per request, so server construction must be
 * cheap. Tool registration is a pure in-memory operation, which is
 * fine; keep anything heavier (workspace handles, remote clients) out
 * of the factory and captured in the closure instead.
 */
export function createFetchHandler(
  createServer: () => McpServer,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
