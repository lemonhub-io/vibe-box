import { describe, expect, it, vi } from "vitest";

import type { McpEnv } from "./route.js";
import { routeMcp, workspaceName } from "./route.js";

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

describe("workspaceName", () => {
  it("returns the workspace query parameter", () => {
    expect(workspaceName(new Request("https://example.com/mcp?workspace=alpha"))).toBe("alpha");
  });

  it("returns null without the parameter", () => {
    expect(workspaceName(new Request("https://example.com/mcp"))).toBeNull();
  });

  it("returns null for an empty parameter", () => {
    expect(workspaceName(new Request("https://example.com/mcp?workspace="))).toBeNull();
  });

  it("returns null for a name with disallowed characters", () => {
    expect(
      workspaceName(new Request("https://example.com/mcp?workspace=../etc/passwd")),
    ).toBeNull();
    expect(workspaceName(new Request("https://example.com/mcp?workspace=has space"))).toBeNull();
  });
});

describe("routeMcp", () => {
  it("returns 404 for non-/mcp paths", async () => {
    const { env } = makeEnv();
    const response = await routeMcp(new Request("https://example.com/"), env);
    expect(response.status).toBe(404);
  });

  it("returns 401 without the bearer token", async () => {
    const { env } = makeEnv();
    const response = await routeMcp(
      new Request("https://example.com/mcp", { method: "POST" }),
      env,
    );
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

  it("forwards authorized requests to the default workspace DO", async () => {
    const { env, doFetch } = makeEnv({ workspace: "default" });
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await routeMcp(request, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("do-response");
    expect(doFetch).toHaveBeenCalledWith(request);
  });

  it("routes to the workspace named by the query parameter", async () => {
    const { env, doFetch } = makeEnv({ workspace: "default" });
    const request = new Request("https://example.com/mcp?workspace=alpha", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await routeMcp(request, env);
    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledWith(request);
  });
});
