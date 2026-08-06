import { describe, expect, it, vi } from "vitest";

import type { McpEnv } from "./route.js";
import { routeMcp } from "./route.js";

function makeEnv(overrides: Partial<{ token: string; workspace: string }> = {}) {
  const doFetch = vi.fn(async () => new Response("do-response"));
  return {
    env: {
      MCP_TOKEN: overrides.token ?? "secret",
      MCP_WORKSPACE: overrides.workspace ?? "default",
      MCP_DO: {
        idFromName(name: string) {
          return { name } as unknown as DurableObjectId;
        },
        get(_id: DurableObjectId) {
          return { fetch: doFetch } as unknown as DurableObjectStub;
        },
      },
    } as unknown as McpEnv,
    doFetch,
  };
}

describe("routeMcp", () => {
  it("returns 404 for non-/mcp paths", async () => {
    const { env } = makeEnv();
    const response = await routeMcp(new Request("https://example.com/"), env);
    expect(response.status).toBe(404);
  });

  it("returns 401 without the bearer token", async () => {
    const { env } = makeEnv();
    const response = await routeMcp(new Request("https://example.com/mcp", { method: "POST" }), env);
    expect(response.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    const { env } = makeEnv();
    const response = await routeMcp(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("forwards authorized requests to the named workspace DO", async () => {
    const { env, doFetch } = makeEnv({ workspace: "my-ws" });
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await routeMcp(request, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("do-response");
    expect(doFetch).toHaveBeenCalledWith(request);
  });
});
