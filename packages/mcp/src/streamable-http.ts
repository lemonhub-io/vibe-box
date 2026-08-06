import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Wrap an MCP server in a fetch handler that speaks the MCP streamable
 * HTTP transport. The Durable Object's `fetch` (or the example
 * worker's top-level `fetch`) can delegate directly to this; auth and
 * routing are the caller's job.
 *
 * A single server instance hosts one live session; the transport is
 * created lazily on first request and reused for the lifetime of the
 * handler. That keeps the DO's state (the connected workspace) stable
 * across the initialize / tools / call sequence MCP clients run.
 *
 * The web-standard transport is used (not the Node wrapper, which goes
 * through `@hono/node-server`) so this code runs unmodified inside
 * workerd.
 */
export function createFetchHandler(server: McpServer): (request: Request) => Promise<Response> {
  let transport: WebStandardStreamableHTTPServerTransport | undefined;

  return async (request: Request) => {
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await server.connect(transport);
    }
    return transport.handleRequest(request);
  };
}
