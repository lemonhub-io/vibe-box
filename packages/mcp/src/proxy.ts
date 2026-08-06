/**
 * The local half of the Vibe Box MCP story.
 *
 * Agents run as local processes and speak MCP over stdio; the
 * workspace lives in a remote Durable Object. This module bridges the
 * two: a stdio MCP server (`createProxyServer`) whose tool surface is
 * whatever a remote Vibe Box endpoint (`createRemoteTools`) exposes.
 *
 * The proxy carries no domain logic. Tool definitions and results are
 * forwarded verbatim, so the DO-side server stays the single source of
 * truth for tool semantics.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface RemoteToolsOptions {
  /** Base URL of the deployed MCP endpoint, e.g. https://x.workers.dev/mcp. */
  url: string;
  /** Bearer token sent as Authorization on every request. */
  token?: string;
  /** Workspace name; appended as ?workspace=<name>. */
  workspace?: string;
}

export interface RemoteTools {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    request: { name: string; arguments?: Record<string, unknown> },
  ): Promise<{ isError?: boolean; content: unknown[] }>;
  close(): Promise<void>;
}

/**
 * Connect to a remote Vibe Box MCP endpoint (streamable HTTP) and
 * expose the minimal client surface the proxy needs.
 */
export async function createRemoteTools(options: RemoteToolsOptions): Promise<RemoteTools> {
  const url = new URL(options.url);
  if (options.workspace !== undefined) url.searchParams.set("workspace", options.workspace);

  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;

  const client = new Client({ name: "vibe-box-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await client.connect(transport);

  return {
    async listTools() {
      return client.listTools() as Promise<{ tools: Array<{ name: string }> }>;
    },
    async callTool(request) {
      return client.callTool({ name: request.name, arguments: request.arguments }) as Promise<{
        isError?: boolean;
        content: unknown[];
      }>;
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Build a stdio-friendly MCP server that forwards its entire tool
 * surface to `remote`. Attach a `StdioServerTransport` (CLI) or an
 * in-memory transport (tests).
 */
export function createProxyServer(remote: RemoteTools): Server {
  const server = new Server(
    { name: "vibe-box-mcp-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await remote.listTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    return remote.callTool({ name: params.name, arguments: params.arguments });
  });

  return server;
}
