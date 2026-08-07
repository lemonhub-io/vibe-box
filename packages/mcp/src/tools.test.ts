import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { McpWorkspace } from "./server.js";
import { createMcpServer } from "./server.js";

// An in-memory workspace that satisfies the structural contract the
// MCP tools operate on. Writes land in a Map; reads come back from it.
class StubWorkspace {
  files = new Map<string, Uint8Array>();
  mkdirs: string[] = [];
  resolveHang?: () => void;
  assets?: { share(path: string, options: { expiresAfter: number }): Promise<string> };
  runtime = {
    exec: async (command: string, options: { cwd?: string }) => {
      if (command === "boom") {
        return {
          result: async () => ({
            exitCode: 1,
            stdout: "",
            stderr: `command failed: ${command}`,
          }),
        };
      }
      if (command === "hang") {
        return {
          result: () =>
            new Promise((resolve) => {
              this.resolveHang = () => resolve({ exitCode: 137, stdout: "", stderr: "killed" });
            }),
          kill: async () => {
            this.resolveHang?.();
          },
        };
      }
      const out = `ran: ${command}${options.cwd ? ` (cwd ${options.cwd})` : ""}`;
      return {
        result: async () => ({ exitCode: 0, stdout: out, stderr: "" }),
      };
    },
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
    mkdir: async (path: string) => {
      this.mkdirs.push(path);
    },
    rm: async () => {},
    readdir: async (path: string) => {
      if (path === "/empty") return [];
      if (path !== "/workspace")
        throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
      return [
        { name: "a.txt", isFile: true, isDirectory: false },
        { name: "sub", isFile: false, isDirectory: true },
      ];
    },
  };
}

async function connectClient(workspace: McpWorkspace) {
  const server = createMcpServer(workspace);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("createMcpServer", () => {
  it("registers read, ls, write, edit, exec, and publish when assets are present", async () => {
    const ws = new StubWorkspace();
    ws.assets = { share: async () => "https://example.invalid/out" };
    const client = await connectClient(ws);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "edit",
      "exec",
      "ls",
      "publish",
      "read",
      "write",
    ]);
  });

  it("skips publish when the workspace has no assets client", async () => {
    const client = await connectClient(new StubWorkspace());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["edit", "exec", "ls", "read", "write"]);
  });

  it("registers the git tools when a git surface is present", async () => {
    const calls: string[][] = [];
    const git = {
      async run(argv: string[]) {
        calls.push(argv);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async push() {
        return "pushed";
      },
      async pull() {
        return "pulled";
      },
      async clone() {
        return "cloned";
      },
    };
    const server = createMcpServer(new StubWorkspace());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    // createMcpServer does not take a git surface; register directly
    // through the shared registration path the local server uses.
    const { registerTools } = await import("./tools.js");
    const extra = new (await import("@modelcontextprotocol/sdk/server/mcp.js")).McpServer({
      name: "git-test",
      version: "0.0.0",
    });
    registerTools(extra, new StubWorkspace(), undefined, git);
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await extra.connect(st2);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct2);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "edit",
      "exec",
      "git",
      "git_clone",
      "git_commit",
      "git_log",
      "git_pull",
      "git_push",
      "git_status",
      "ls",
      "read",
      "write",
    ]);
    const status = await client.callTool({ name: "git_status", arguments: {} });
    expect(calls).toContainEqual(["status", "--short"]);
  });

  it("writes then reads a file through the workspace fs", async () => {
    const ws = new StubWorkspace();
    const client = await connectClient(ws);
    const write = await client.callTool({
      name: "write",
      arguments: { path: "/workspace/hello.txt", content: "hello world" },
    });
    expect(write.isError).toBeFalsy();
    const read = await client.callTool({
      name: "read",
      arguments: { path: "/workspace/hello.txt" },
    });
    const text = (read.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(text).toContain("hello world");
  });

  it("creates missing parent directories on write", async () => {
    const ws = new StubWorkspace();
    const client = await connectClient(ws);
    const write = await client.callTool({
      name: "write",
      arguments: { path: "/workspace/a/b/c.txt", content: "deep" },
    });
    expect(write.isError).toBeFalsy();
    expect(ws.mkdirs).toContain("/workspace/a/b");
  });

  it("lists a directory", async () => {
    const client = await connectClient(new StubWorkspace());
    const ls = await client.callTool({ name: "ls", arguments: { path: "/workspace" } });
    const text = (ls.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(text).toContain("a.txt");
    expect(text).toContain("sub");
  });

  it("applies an exact-replacement edit", async () => {
    const ws = new StubWorkspace();
    ws.files.set("/workspace/a.txt", new TextEncoder().encode("before middle after"));
    const client = await connectClient(ws);
    const edit = await client.callTool({
      name: "edit",
      arguments: { path: "/workspace/a.txt", oldText: "middle", newText: "edited" },
    });
    expect(edit.isError).toBeFalsy();
    expect(new TextDecoder().decode(ws.files.get("/workspace/a.txt"))).toBe("before edited after");
  });

  it("rejects an edit whose oldText is not unique", async () => {
    const ws = new StubWorkspace();
    ws.files.set("/workspace/a.txt", new TextEncoder().encode("dup dup"));
    const client = await connectClient(ws);
    const edit = await client.callTool({
      name: "edit",
      arguments: { path: "/workspace/a.txt", oldText: "dup", newText: "x" },
    });
    expect(edit.isError).toBe(true);
  });

  it("rejects an edit whose oldText is missing", async () => {
    const ws = new StubWorkspace();
    ws.files.set("/workspace/a.txt", new TextEncoder().encode("nothing here"));
    const client = await connectClient(ws);
    const edit = await client.callTool({
      name: "edit",
      arguments: { path: "/workspace/a.txt", oldText: "absent", newText: "x" },
    });
    expect(edit.isError).toBe(true);
  });

  it("runs a command through the workspace runtime", async () => {
    const client = await connectClient(new StubWorkspace());
    const exec = await client.callTool({
      name: "exec",
      arguments: { command: "ls -la", cwd: "/workspace" },
    });
    const text = (exec.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(text).toContain("ran: ls -la (cwd /workspace)");
    expect(text).toContain("exit 0");
  });

  it("reports a failing command through the workspace runtime", async () => {
    const client = await connectClient(new StubWorkspace());
    const exec = await client.callTool({ name: "exec", arguments: { command: "boom" } });
    const text = (exec.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(text).toContain("command failed: boom");
  });

  it("kills a command that exceeds the exec timeout", async () => {
    const ws = new StubWorkspace();
    const client = await connectClient(ws);
    const exec = await client.callTool({
      name: "exec",
      arguments: { command: "hang", timeoutMs: 50 },
    });
    expect(exec.isError).toBe(true);
    const text = (exec.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(text).toContain("timed out after 50ms");
    expect(text).toContain("hang");
  });

  it("truncates reads of large files with a marker", async () => {
    const ws = new StubWorkspace();
    // Just over the 1 MiB read cap.
    const big = "x".repeat(1024 * 1024 + 17);
    ws.files.set("/workspace/big.txt", new TextEncoder().encode(big));
    const client = await connectClient(ws);
    const read = await client.callTool({ name: "read", arguments: { path: "/workspace/big.txt" } });
    const text = (read.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(read.isError).toBeFalsy();
    expect(text).toContain("[truncated: file is");
  });

  it("publishes through the assets client", async () => {
    const ws = new StubWorkspace();
    ws.assets = { share: async () => "https://example.invalid/out" };
    const client = await connectClient(ws);
    const publish = await client.callTool({
      name: "publish",
      arguments: { path: "/workspace/out.png" },
    });
    const text = (publish.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    expect(text).toContain("https://example.invalid/out");
  });
});
