// Top-level routing for the MCP example worker.
//
// Only /mcp exists, gated by the bearer token. The workspace is
// addressed by name: the `?workspace=<name>` query parameter wins,
// falling back to `env.MCP_WORKSPACE`. Split out of the worker entry
// so unit tests can drive it without booting the Durable Object.

export interface McpEnv {
  MCP_TOKEN: string;
  MCP_WORKSPACE: string;
  MCP_DO: DurableObjectNamespace;
}

/** The workspace name a request targets, or null to use the default. */
export function workspaceName(request: Request): string | null {
  const value = new URL(request.url).searchParams.get("workspace");
  return value !== null && value.length > 0 ? value : null;
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
