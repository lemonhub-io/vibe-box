import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createProxyServer, createRemoteTools, type RemoteToolsOptions } from "./proxy.js";

/**
 * Run the local MCP proxy: a stdio MCP server that forwards its tool
 * surface to a remote Vibe Box endpoint. Resolves when the stdio
 * session ends; rejects on startup or transport failures.
 */
export async function runProxy(options: RemoteToolsOptions): Promise<void> {
  const remote = await createRemoteTools(options);
  const server = createProxyServer(remote);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.onclose = () => {
      void remote.close();
      resolve();
    };
  });
}
