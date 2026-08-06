// Top-level routing for the MCP example worker.
//
// Only /mcp exists, gated by the bearer token. Split out of the
// worker entry so unit tests can drive it without booting the
// Durable Object.

export interface McpEnv {
  MCP_TOKEN: string;
  MCP_WORKSPACE: string;
  MCP_DO: DurableObjectNamespace;
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

  const stub = env.MCP_DO.get(env.MCP_DO.idFromName(env.MCP_WORKSPACE));
  return stub.fetch(request);
}
