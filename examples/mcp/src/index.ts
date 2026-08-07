// Example Worker + Durable Object exposing a Workspace through the
// MCP protocol.
//
// The DO owns one Workspace: a SQLite filesystem with optional git
// support (isomorphic-git over the VFS) and, on the paid plan, a
// shell backed by a Dynamic Worker. The top-level worker answers MCP
// streamable-HTTP requests on /mcp, gated by a bearer token.
//
// Wire shape:
//
//   MCP client ──► vibe-mcp-server (local stdio proxy)
//                      │  HTTP JSON-RPC (streamable)
//                      ▼
//              Worker /mcp ──► MCPDo DO ──► Workspace (SQLite fs + git)
//                                              │  runtime.exec (paid)
//                                              ▼
//                                    Dynamic Worker (just-bash)

import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from "@vibe-box/computer";
import { WorkerShellBackend } from "@vibe-box/computer/backends/worker-shell";
import { createGitClient } from "@vibe-box/computer/git";
import {
  createFetchHandler,
  createMcpServer,
  type McpGitSurface,
  type McpWorkspace,
} from "@vibe-box/mcp";

import { createGitAdapter } from "./git-adapter.js";
import type { McpEnv } from "./route.js";
import { routeMcp } from "./route.js";

// The mixin owns the Workspace and installs the prototype accessor
// `getWorkspace` dispatches to. The options callback runs after
// super(...), so it can read self.ctx / self.env. The shell backend —
// which dispatches runtime.exec into a Dynamic Worker loaded through
// env.LOADER, powering the MCP `exec` tool — is gated behind
// env.MCP_SHELL: Dynamic Workers need the Workers Paid plan, so the
// default (Free) configuration deploys without a shell and the exec
// tool does not register.
export class MCPDo extends withWorkspace(class extends DurableObject<McpEnv> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: McpEnv };
  const backends = [];
  if (env.MCP_SHELL === "true") {
    backends.push(
      new WorkerShellBackend({
        loader: env.LOADER,
        workspace: { binding: "MCP_DO", id: ctx.id.toString() },
        ctx,
      }),
    );
  }
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends,
    // Full git support over the SQLite VFS via isomorphic-git:
    // clone/commit/push/pull work on a filesystem-only workspace.
    git: createGitClient(),
    defaultGitIdentity: {
      name: env.GIT_IDENTITY_NAME ?? "vibe-box-agent",
      email: env.GIT_IDENTITY_EMAIL ?? "agent@vibe-box.example.invalid",
    },
  };
}) {
  // The workspace handle is fetched once and cached; the MCP handler
  // itself is rebuilt per request because the stateless transport
  // must not be reused (and DO instances can be evicted between
  // requests, which would orphan any in-memory session state).
  private workspace?: McpWorkspace;
  private gitSurface?: McpGitSurface;

  async fetch(request: Request): Promise<Response> {
    const { ctx, env } = this as unknown as { ctx: DurableObjectState; env: McpEnv };
    if (this.workspace === undefined) {
      // getWorkspace returns a WorkspaceClient whose fs/runtime/git
      // surface satisfies the MCP structural contract.
      this.workspace = (await getWorkspace(this)) as unknown as McpWorkspace;
      const client = this.workspace as unknown as {
        git: Parameters<typeof createGitAdapter>[0]["git"];
      };
      this.gitSurface = createGitAdapter({
        git: client.git,
        authorization: env.GIT_TOKEN ? `Bearer ${env.GIT_TOKEN}` : undefined,
        identity:
          env.GIT_IDENTITY_NAME !== undefined && env.GIT_IDENTITY_EMAIL !== undefined
            ? { name: env.GIT_IDENTITY_NAME, email: env.GIT_IDENTITY_EMAIL }
            : undefined,
      });
    }
    const handler = createFetchHandler(() => createMcpServer(this.workspace!, this.gitSurface));
    return handler(request);
  }
}

export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    return routeMcp(request, env);
  },
} satisfies ExportedHandler<McpEnv>;
