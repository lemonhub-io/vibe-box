// Example Worker + Durable Object exposing a Workspace through the
// MCP protocol.
//
// The DO owns one Workspace with a shell backed by a Dynamic Worker
// (just-bash through the Worker Loader), and answers MCP
// streamable-HTTP requests on the top-level worker's /mcp route. A
// shared secret gates access: every request must carry
// `Authorization: Bearer <MCP_TOKEN>`.
//
// Wire shape:
//
//   MCP client ──► vibe-mcp-server (local stdio proxy)
//                      │  HTTP JSON-RPC (streamable)
//                      ▼
//              Worker /mcp ──► MCPDo DO ──► Workspace (SQLite fs)
//                                              │  runtime.exec
//                                              ▼
//                                    Dynamic Worker (just-bash)

import { DurableObject } from "cloudflare:workers";

import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from "@vibe-box/computer";
import { WorkerShellBackend } from "@vibe-box/computer/backends/worker-shell";
import { createFetchHandler, createMcpServer, type McpWorkspace } from "@vibe-box/mcp";

import type { McpEnv } from "./route.js";
import { routeMcp } from "./route.js";

// The mixin owns the Workspace and installs the prototype accessor
// `getWorkspace` dispatches to. The options callback runs after
// super(...), so it can read self.ctx / self.env. The shell backend
// dispatches every runtime.exec into a Dynamic Worker loaded through
// env.LOADER — that is what makes the MCP `exec` tool able to run
// real commands.
export class MCPDo extends withWorkspace(class extends DurableObject<McpEnv> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: McpEnv };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        loader: env.LOADER,
        workspace: { binding: "MCP_DO", id: ctx.id.toString() },
        ctx,
      }),
    ],
  };
}) {
  async fetch(request: Request): Promise<Response> {
    // getWorkspace returns a WorkspaceClient whose fs/runtime surface
    // satisfies the MCP structural contract.
    const ws = (await getWorkspace(this)) as unknown as McpWorkspace;
    const handler = createFetchHandler(createMcpServer(ws));
    return handler(request);
  }
}

export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    return routeMcp(request, env);
  },
} satisfies ExportedHandler<McpEnv>;
