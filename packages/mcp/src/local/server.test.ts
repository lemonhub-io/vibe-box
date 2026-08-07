import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createLocalServer } from "./server.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-local-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

async function connect(root: string, autoCommit = true) {
  const server = createLocalServer({ root, autoCommit });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function toolText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

describe("createLocalServer", () => {
  it("registers the twelve tools", async () => {
    const root = await makeRepo();
    try {
      const client = await connect(root);
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-commits a write", async () => {
    const root = await makeRepo();
    try {
      const client = await connect(root);
      const out = await toolText(client, "write", { path: "/workspace/a.txt", content: "hello" });
      expect(out).toContain("Wrote");
      expect(await toolText(client, "git_status", {})).toBe("(clean)");
      expect(await toolText(client, "git_log", {})).toContain("mcp: write /workspace/a.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not auto-commit when disabled", async () => {
    const root = await makeRepo();
    try {
      const client = await connect(root, false);
      await toolText(client, "write", { path: "/workspace/a.txt", content: "hello" });
      expect(await toolText(client, "git_status", {})).toContain("a.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs exec and auto-commits the change", async () => {
    const root = await makeRepo();
    try {
      const client = await connect(root);
      const out = await toolText(client, "exec", { command: "echo hi > out.txt" });
      expect(out).toContain("exit 0");
      expect(await toolText(client, "git_status", {})).toBe("(clean)");
      expect(await toolText(client, "git_log", {})).toContain("mcp: exec echo hi > out.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("works in a non-repo directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-plain-"));
    try {
      const client = await connect(root);
      const out = await toolText(client, "write", { path: "/workspace/a.txt", content: "hi" });
      expect(out).toContain("Wrote");
      const status = await toolText(client, "git_status", {});
      expect(status).toContain("not a git repository");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
