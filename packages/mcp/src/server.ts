import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpGitSurface, McpWorkspace } from "./tools.js";
import { registerTools } from "./tools.js";

/**
 * Build an MCP server exposing a workspace's file and execution
 * surface, plus the git tools when a git surface is supplied. The
 * returned server has no transport attached; connect it to a
 * streamable-HTTP transport on the Durable Object (see
 * `createFetchHandler`) or an in-memory transport in tests.
 */
export function createMcpServer(workspace: McpWorkspace, git?: McpGitSurface): McpServer {
  const server = new McpServer({ name: "vibe-box", version: "0.1.0" });
  registerTools(server, workspace, undefined, git);
  return server;
}

export type { McpGitSurface, McpWorkspace } from "./tools.js";
