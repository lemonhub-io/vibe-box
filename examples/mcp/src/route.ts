// Top-level routing for the MCP example worker.
//
// Only /mcp exists, gated by the bearer token. The workspace is
// addressed by name: the `?workspace=<name>` query parameter wins,
// falling back to `env.MCP_WORKSPACE`. Split out of the worker entry
// so unit tests can drive it without booting the Durable Object.

export interface McpEnv {
  MCP_TOKEN: string;
  MCP_WORKSPACE: string;
  MCP_SHELL?: string;
  MCP_DO: DurableObjectNamespace;
  LOADER?: WorkerLoader;
  /** Optional bearer token for git push/pull/clone to private remotes. */
  GIT_TOKEN?: string;
  /** Git identity for commit-producing operations. */
  GIT_IDENTITY_NAME?: string;
  GIT_IDENTITY_EMAIL?: string;
}

/** Workspace names are DO ids; keep them tame. */
const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,63}$/;

/** The workspace name a request targets, or null to use the default. */
export function workspaceName(request: Request): string | null {
  const value = new URL(request.url).searchParams.get("workspace");
  if (value === null || value.length === 0) return null;
  if (!WORKSPACE_NAME_RE.test(value)) return null;
  return value;
}

export async function routeMcp(request: Request, env: McpEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== "/mcp") {
    return new Response("not found", { status: 404 });
  }

  const expected = `Bearer ${env.MCP_TOKEN}`;
  if (request.headers.get("authorization") !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const name = workspaceName(request) ?? env.MCP_WORKSPACE;
  const stub = env.MCP_DO.get(env.MCP_DO.idFromName(name));
  return stub.fetch(request);
}
