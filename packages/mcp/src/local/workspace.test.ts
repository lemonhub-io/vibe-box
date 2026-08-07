import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LocalWorkspace } from "./workspace.js";

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vibe-ws-"));
}

function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
}

describe("LocalWorkspace", () => {
  it("writes, reads, lists, and stats files under the root", async () => {
    const root = await makeDir();
    try {
      const ws = new LocalWorkspace(root);
      await ws.fs.writeFile("/workspace/a.txt", new TextEncoder().encode("hello"));
      await ws.fs.mkdir("/workspace/sub", { recursive: true });
      await ws.fs.writeFile("/workspace/sub/b.txt", new TextEncoder().encode("world"));
      expect(
        new TextDecoder().decode(await drain(await ws.fs.readFile("/workspace/a.txt"))),
      ).toBe("hello");
      const entries = await ws.fs.readdir("/workspace");
      expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
      const stat = await ws.fs.stat("/workspace/a.txt");
      expect(stat.isFile).toBe(true);
      await ws.fs.rm("/workspace/a.txt");
      await expect(ws.fs.stat("/workspace/a.txt")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a command through runtime.exec", async () => {
    const root = await makeDir();
    try {
      const ws = new LocalWorkspace(root);
      const handle = await ws.runtime!.exec("printf hi", { encoding: "utf8" });
      const result = await handle.result();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hi");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the workspace root", async () => {
    const root = await makeDir();
    try {
      const ws = new LocalWorkspace(root);
      await expect(ws.fs.readFile("/etc/passwd")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
