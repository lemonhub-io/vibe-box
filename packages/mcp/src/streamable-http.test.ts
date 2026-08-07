import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";
import { createFetchHandler } from "./streamable-http.js";
import type { McpWorkspace } from "./tools.js";

class StubWorkspace {
  files = new Map<string, Uint8Array>();
  fs = {
    stat: async (path: string) => {
      const raw = this.files.get(path);
      if (!raw) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      return { size: raw.byteLength, mtime: 0, mode: 0o644, isFile: true, isDirectory: false };
    },
    readFile: async (path: string) => {
      const raw = this.files.get(path);
      if (!raw) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      return new ReadableStream({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      });
    },
    writeFile: async (path: string, content: Uint8Array) => {
      this.files.set(path, content);
    },
    mkdir: async () => {},
    rm: async () => {},
    readdir: async (path: string) => {
      if (path !== "/workspace")
        throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
      return [{ name: "a.txt", isFile: true, isDirectory: false }];
    },
  };
  runtime = {
    exec: async (command: string) => ({
      result: async () => ({ exitCode: 0, stdout: `ran: ${command}`, stderr: "" }),
    }),
  };
}

// Build a real web-standard Request so the transport can parse the
// body with request.json() like it would in workerd.
function fakeRequest(method: string, body?: unknown, initHeaders?: HeadersInit): Request {
  const headers = new Headers(initHeaders);
  headers.set("accept", "application/json, text/event-stream");
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://internal/mcp", {
    method,
    headers,
    // The client passes an already-serialized JSON string as the body.
    body: typeof body === "string" ? body : undefined,
  });
}

describe("createFetchHandler", () => {
  let handler: (request: Request) => Promise<Response>;
  let client: Client;

  beforeEach(async () => {
    const ws: McpWorkspace = new StubWorkspace();
    handler = createFetchHandler(() => createMcpServer(ws));
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  });

  afterEach(async () => {
    await client.close();
  });

  it("initializes and lists tools over streamable HTTP", async () => {
    // Drive the client over an in-process streamable HTTP client
    // transport whose fetch goes through our handler.
    const transport = new StreamableHTTPClientTransport(new URL("http://internal/mcp"), {
      requestInit: {},
      fetch: async (url, init) =>
        handler(
          fakeRequest(String(init?.method ?? "GET"), init?.body as unknown, init?.headers),
        ) as Promise<Response & { status: number }>,
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["edit", "exec", "ls", "read", "write"]);
  });

  it("round-trips a write followed by a read", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("http://internal/mcp"), {
      requestInit: {},
      fetch: async (url, init) =>
        handler(
          fakeRequest(String(init?.method ?? "GET"), init?.body as unknown, init?.headers),
        ) as Promise<Response & { status: number }>,
    });
    await client.connect(transport);
    const write = await client.callTool({
      name: "write",
      arguments: { path: "/workspace/hello.txt", content: "hello" },
    });
    expect(write.isError).toBeFalsy();
    const read = await client.callTool({
      name: "read",
      arguments: { path: "/workspace/hello.txt" },
    });
    const textContent = (read.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(textContent).toBe("hello");
  });
});
