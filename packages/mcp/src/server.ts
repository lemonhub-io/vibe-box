import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpWorkspace } from "./tools.js";
import { registerTools } from "./tools.js";

/**
 * Build an MCP server exposing a workspace's file and execution
 * surface. The returned server has no transport attached; connect it
 * to a streamable-HTTP transport on the Durable Object (see
 * `createFetchHandler`) or an in-memory transport in tests.
 */
export function createMcpServer(workspace: McpWorkspace): McpServer {
  const server = new McpServer({ name: "vibe-box", version: "0.1.0" });
  registerTools(server, workspace);
  return server;
}

export type { McpWorkspace } from "./tools.js";
