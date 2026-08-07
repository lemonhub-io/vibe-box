import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProxyServer, createRemoteTools, type RemoteTools } from "./proxy.js";
import { createMcpServer } from "./server.js";
import { createFetchHandler } from "./streamable-http.js";
import type { McpWorkspace } from "./tools.js";

// The same structural workspace the other suites use, plus a runtime so
// exec registers.
class StubWorkspace {
  files = new Map<string, Uint8Array>();
  runtime = {
    exec: async (command: string) => ({
      result: async () => ({ exitCode: 0, stdout: `ran: ${command}`, stderr: "" }),
    }),
  };
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
}

describe("createRemoteTools", () => {
  let http: Server;
  let url: string;

  beforeEach(async () => {
    // Host a real streamable-HTTP MCP endpoint over node:http, the way
    // a deployed worker would present it.
    const handler = createFetchHandler(() => createMcpServer(new StubWorkspace()));
    http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString();
        const response = await handler(
          new Request(`http://local${req.url ?? "/"}`, {
            method: req.method,
            headers: new Headers(req.headers as Record<string, string>),
            body: body.length > 0 ? body : undefined,
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("lists and calls tools through the remote endpoint", async () => {
    const remote = await createRemoteTools({ url });
    const { tools } = await remote.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["edit", "exec", "ls", "read", "write"]);
    const result = await remote.callTool({
      name: "write",
      arguments: { path: "/workspace/a.txt", content: "hi" },
    });
    expect(result.isError).toBeFalsy();
    await remote.close();
  });
});

describe("createProxyServer", () => {
  it("forwards listTools and callTool to the remote", async () => {
    // Stub remote: records what the proxy asks for.
    const calls: string[] = [];
    const remote: RemoteTools = {
      async listTools() {
        calls.push("listTools");
        return {
          tools: [
            { name: "read", inputSchema: { type: "object", properties: {} } },
            { name: "write", inputSchema: { type: "object", properties: {} } },
          ],
        };
      },
      async callTool(request) {
        calls.push(`callTool:${request.name}`);
        return { content: [{ type: "text", text: `stub ${request.name}` }] };
      },
      async close() {},
    };

    const proxy = createProxyServer(remote);
    const [agentTransport, proxyTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(proxyTransport);
    const agent = new Client({ name: "test-agent", version: "0.0.0" }, { capabilities: {} });
    await agent.connect(agentTransport);

    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["read", "write"]);
    const result = await agent.callTool({ name: "write", arguments: { path: "x", content: "y" } });
    const textContent = (result.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(textContent).toBe("stub write");
    expect(calls).toEqual(["listTools", "callTool:write"]);
    await agent.close();
  });
});
