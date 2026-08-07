# Local Git Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `vibe-mcp-server --local <dir>` — a fully local MCP server whose workspace is a Git working tree, with file tools, local exec, git tools, and optional auto-commit.

**Architecture:** `LocalWorkspace` adapts node:fs and child_process spawn to the existing `McpWorkspace` structural contract; `GitRunner` wraps the git CLI; `createLocalServer` registers the five file tools (via existing `registerTools`) plus five `git_*` tools, and hooks auto-commit after write/edit/exec.

**Tech Stack:** TypeScript, node:fs/promises, child_process, vitest, `@modelcontextprotocol/sdk` (already in `@vibe-box/mcp`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-local-git-design.md`.
- Repo conventions: ESM `type: module`; tsc build; vitest; biome; commit scoped `mcp:`.
- Remote mode (proxy, server worker, streamable HTTP) must not change.
- No new runtime dependencies — node:fs, child_process, and the git CLI only.
- Git CLI must be available on PATH (dev machines have it; the CI runner does too).

---

### Task 1: `GitRunner` (git CLI wrapper)

**Files:**
- Create: `packages/mcp/src/local/git.ts`
- Test: `packages/mcp/src/local/git.test.ts`

**Interfaces:**
- Produces:
  - `GitRunner` class with:
    - `constructor(cwd: string)`
    - `isRepo(): Promise<boolean>` — true when `<cwd>/.git` exists (file or dir)
    - `status(): Promise<string>` — `git status --short` output, trimmed
    - `commitAll(message: string): Promise<string>` — `git add -A` + `git commit -m message`; returns commit output; throws on git failure
    - `push(): Promise<string>` — `git push`
    - `pull(): Promise<string>` — `git pull --ff-only`
    - `log(maxCount?: number): Promise<string>` — `git log --oneline -n <maxCount>` (default 10)

- [ ] **Step 1: Write failing test** `packages/mcp/src/local/git.test.ts`

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import { GitRunner } from "./git.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-bare-"));
  execFileSync("git", ["init", "--bare"], { cwd: dir });
  return dir;
}

describe("GitRunner", () => {
  it("detects a repository", async () => {
    const dir = await makeRepo();
    try {
      expect(await new GitRunner(dir).isRepo()).toBe(true);
      expect(await new GitRunner(join(dir, "..")).isRepo()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports status and commits all changes", async () => {
    const dir = await makeRepo();
    try {
      await import("node:fs/promises").then((fs) => fs.writeFile(join(dir, "a.txt"), "hello\n"));
      const runner = new GitRunner(dir);
      expect(await runner.status()).toContain("a.txt");
      const out = await runner.commitAll("add a.txt");
      expect(out).toContain("add a.txt");
      expect((await runner.status()).trim()).toBe("");
      expect(await runner.log(3)).toContain("add a.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pushes to and pulls from a bare remote", async () => {
    const dir = await makeRepo();
    const bare = await makeBareRemote();
    try {
      const runner = new GitRunner(dir);
      await import("node:fs/promises").then((fs) => fs.writeFile(join(dir, "b.txt"), "x\n"));
      await runner.commitAll("add b.txt");
      execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
      await runner.push();
      const cloneDir = await mkdtemp(join(tmpdir(), "vibe-clone-"));
      try {
        execFileSync("git", ["clone", bare, cloneDir], { stdio: "pipe" });
        const cloneRunner = new GitRunner(cloneDir);
        expect(await cloneRunner.log(3)).toContain("add b.txt");
        await import("node:fs/promises").then((fs) => fs.writeFile(join(cloneDir, "c.txt"), "y\n"));
        await cloneRunner.commitAll("add c.txt");
        await cloneRunner.push();
        await runner.pull();
        expect(await runner.log(3)).toContain("add c.txt");
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @vibe-box/mcp -- src/local/git.test.ts`
Expected: FAIL (module `./git.js` not found).

- [ ] **Step 3: Implement git.ts**

```ts
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function run(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ code: typeof error.code === "number" ? error.code : null, stdout, stderr });
      } else {
        resolve({ code: 0, stdout, stderr });
      }
    });
  });
}

export class GitRunner {
  constructor(private readonly cwd: string) {}

  async isRepo(): Promise<boolean> {
    try {
      await access(join(this.cwd, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  private async run(args: string[], what: string): Promise<string> {
    const { code, stdout, stderr } = await run(this.cwd, args);
    if (code !== 0) {
      throw new GitError(`${what} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`, code, stdout, stderr);
    }
    return stdout.trim();
  }

  async status(): Promise<string> {
    return this.run(["status", "--short"], "git status");
  }

  async commitAll(message: string): Promise<string> {
    await this.run(["add", "-A"], "git add");
    return this.run(["commit", "-m", message], "git commit");
  }

  async push(): Promise<string> {
    return this.run(["push"], "git push");
  }

  async pull(): Promise<string> {
    return this.run(["pull", "--ff-only"], "git pull");
  }

  async log(maxCount = 10): Promise<string> {
    return this.run(["log", "--oneline", `-n ${maxCount}`], "git log");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @vibe-box/mcp -- src/local/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/local
git commit -m "mcp: add git CLI runner for local workspaces"
```

---

### Task 2: `LocalWorkspace` (fs + exec adapter)

**Files:**
- Create: `packages/mcp/src/local/workspace.ts`
- Test: `packages/mcp/src/local/workspace.test.ts`

**Interfaces:**
- Produces: `LocalWorkspace implements McpWorkspace` — see spec. Paths in the MCP contract are absolute workspace paths (`/workspace/foo`); the adapter strips the `/workspace` prefix and resolves against `root`. `fs.readFile` returns `ReadableStream<Uint8Array>`; `runtime.exec(command, { cwd })` spawns with `shell: "/bin/sh"`, resolves `handle.result()` with `{ exitCode, stdout, stderr }`, and exposes `kill()`.

- [ ] **Step 1: Write failing test** `packages/mcp/src/local/workspace.test.ts`

```ts
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
      expect(new TextDecoder().decode(await drain(await ws.fs.readFile("/workspace/a.txt")))).toBe("hello");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @vibe-box/mcp -- src/local/workspace.test.ts`
Expected: FAIL (module `./workspace.js` not found).

- [ ] **Step 3: Implement workspace.ts**

```ts
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { basename as _b } from "node:path";

import type { McpWorkspace } from "../tools.js";

export class WorkspacePathError extends Error {
  constructor(path: string) {
    super(`path outside workspace: ${path}`);
  }
}

/** Map an absolute workspace path (/workspace/x) to a filesystem path under root. */
export function resolveWorkspacePath(root: string, path: string): string {
  const cleaned = path.replace(/^\/+/, "");
  const resolved = resolve(join(root, cleaned));
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new WorkspacePathError(path);
  }
  return resolved;
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export class LocalWorkspace implements McpWorkspace {
  constructor(readonly root: string) {}

  fs = {
    stat: async (path: string) => {
      const s = await stat(resolveWorkspacePath(this.root, path));
      return { size: s.size, mtime: s.mtimeMs, mode: s.mode, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    readFile: async (path: string) => {
      const bytes = await readFile(resolveWorkspacePath(this.root, path));
      return toReadableStream(bytes);
    },
    writeFile: async (path: string, content: Uint8Array, options?: { mode?: number }) => {
      const target = resolveWorkspacePath(this.root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, options);
    },
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      await mkdir(resolveWorkspacePath(this.root, path), { recursive: options?.recursive });
    },
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      await rm(resolveWorkspacePath(this.root, path), { recursive: options?.recursive, force: options?.force });
    },
    readdir: async (path: string) => {
      const entries = await readdir(resolveWorkspacePath(this.root, path), { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    },
  };

  runtime = {
    exec: async (command: string, options: { cwd?: string; encoding: "utf8" }) => {
      const cwd = options.cwd === undefined ? this.root : resolveWorkspacePath(this.root, options.cwd);
      const child = spawn(command, { cwd, shell: "/bin/sh", stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed = false;
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        child.on("error", rejectPromise);
        child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
      });
      return {
        result: () => result,
        kill: async () => {
          killed = true;
          child.kill("SIGKILL");
        },
      };
    },
  };
}
```

Note: the `killed` flag is unused in this version; omit it if biome flags it, keeping the kill surface per the McpWorkspace contract.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @vibe-box/mcp -- src/local/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/local
git commit -m "mcp: add local workspace adapter (fs + spawn exec)"
```

---

### Task 3: `createLocalServer` (full tool set + auto-commit)

**Files:**
- Create: `packages/mcp/src/local/server.ts`
- Test: `packages/mcp/src/local/server.test.ts`
- Modify: `packages/mcp/src/index.ts`

**Interfaces:**
- Produces:
  - `createLocalServer(options: { root: string; autoCommit?: boolean }): McpServer`
  - Registered tools: read, ls, write, edit, exec, git_status, git_commit, git_push, git_pull, git_log.
  - Auto-commit (default on, skipped when not a repo): after write → `mcp: write <path>`; after edit → `mcp: edit <path>`; after exec → `mcp: exec <first 80 chars>`; commit failures after a successful tool call are reported as a warning suffix on the tool result, not an error.
- Exports from `packages/mcp/src/index.ts`: `createLocalServer`.

- [ ] **Step 1: Write failing test** `packages/mcp/src/local/server.test.ts`

```ts
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

async function toolText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

describe("createLocalServer", () => {
  it("registers the ten tools", async () => {
    const root = await makeRepo();
    try {
      const client = await connect(root);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "edit", "exec", "git_commit", "git_log", "git_pull", "git_push", "git_status", "ls", "read", "write",
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
      expect(await toolText(client, "git_status", {})).toBe("");
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
      expect(await toolText(client, "git_status", {})).toBe("");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @vibe-box/mcp -- src/local/server.test.ts`
Expected: FAIL (module `./server.js` not found).

- [ ] **Step 3: Implement server.ts**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpWorkspace } from "../tools.js";
import { registerTools } from "../tools.js";
import { GitRunner } from "./git.js";
import { LocalWorkspace } from "./workspace.js";

export interface LocalServerOptions {
  root: string;
  autoCommit?: boolean;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

export function createLocalServer(options: LocalServerOptions): McpServer {
  const root = options.root;
  const autoCommit = options.autoCommit ?? true;
  const ws: McpWorkspace = new LocalWorkspace(root);
  const git = new GitRunner(root);
  const server = new McpServer({ name: "vibe-box-local", version: "0.1.0" });

  const hook = async (message: string): Promise<string> => {
    if (!autoCommit) return "";
    if (!(await git.isRepo())) return "";
    try {
      const out = await git.commitAll(message);
      return out ? `\n[auto-commit] ${out.split("\n")[0]}` : "";
    } catch (err) {
      return `\n[auto-commit failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // File tools with auto-commit hooks. We re-register rather than use
  // registerTools' plain handlers so write/edit/exec can append the
  // commit note to their output.
  server.tool(
    "write",
    "Write a file to the workspace, creating parent directories as needed. Overwrites existing content.",
    { path: z.string(), content: z.string() },
    async ({ path, content }) => {
      try {
        await ws.fs.writeFile(path, new TextEncoder().encode(content));
        const note = await hook(`mcp: write ${path}`);
        return textResult(`Wrote ${path}.${note}`);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "edit",
    "Apply a precise replacement to a file. oldText must appear exactly once in the file.",
    { path: z.string(), oldText: z.string(), newText: z.string() },
    async ({ path, oldText, newText }) => {
      try {
        const bytes = await new Response(await ws.fs.readFile(path)).arrayBuffer();
        const content = new TextDecoder().decode(bytes);
        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) {
          return textResult(`Could not find the exact text in ${path}.`);
        }
        if (occurrences > 1) {
          return textResult(`Found ${occurrences} occurrences of the text in ${path}.`);
        }
        const newContent = content.replace(oldText, newText);
        await ws.fs.writeFile(path, new TextEncoder().encode(newContent));
        const note = await hook(`mcp: edit ${path}`);
        return textResult(`Edited ${path}.${note}`);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "exec",
    "Run a shell command in the workspace and return its exit code, stdout, and stderr.",
    {
      command: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
    async ({ command, cwd, timeoutMs }) => {
      try {
        const handle = await ws.runtime!.exec(command, { encoding: "utf8", cwd });
        const result = await (async () => {
          if (timeoutMs !== undefined && handle.kill !== undefined) {
            return Promise.race([
              handle.result(),
              new Promise<{ exitCode: number; stdout: string; stderr: string }>((_, reject) => {
                setTimeout(() => {
                  reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
                  void handle.kill!();
                }, timeoutMs);
              }),
            ]);
          }
          return handle.result();
        })();
        const parts = [`exit ${result.exitCode}`];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`stderr: ${result.stderr}`);
        const note = result.exitCode === 0 ? await hook(`mcp: exec ${command.slice(0, 80)}`) : "";
        return textResult(parts.join("\n") + note);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool("ls", "List entries in a workspace directory.", { path: z.string() }, async ({ path }) => {
    try {
      const entries = await ws.fs.readdir(path);
      return textResult(JSON.stringify({ path, entries }, null, 2));
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.tool("read", "Read a file from the workspace and return its contents.", { path: z.string() }, async ({ path }) => {
    try {
      const bytes = await new Response(await ws.fs.readFile(path)).arrayBuffer();
      return textResult(new TextDecoder().decode(bytes));
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.tool("git_status", "Show the working tree status.", {}, async () => {
    try {
      return textResult(await git.status() || "(clean)");
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.tool("git_commit", "Commit all pending changes with a message.", { message: z.string() }, async ({ message }) => {
    try {
      return textResult(await git.commitAll(message));
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.tool("git_push", "Push the current branch to its remote.", {}, async () => {
    try {
      return textResult(await git.push());
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.tool("git_pull", "Pull the current branch from its remote.", {}, async () => {
    try {
      return textResult(await git.pull());
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.tool("git_log", "Show recent commits.", { maxCount: z.number().int().positive().optional() }, async ({ maxCount }) => {
    try {
      return textResult(await git.log(maxCount));
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}
```

Note: `registerTools` import is unused in this version — remove the import if biome flags it (the local server re-implements the five file tools with hooks).

- [ ] **Step 4: Export from index.ts**

```ts
export { createLocalServer, type LocalServerOptions } from "./local/server.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @vibe-box/mcp -- src/local/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src
git commit -m "mcp: add local git workspace server with auto-commit"
```

---

### Task 4: CLI `--local` mode

**Files:**
- Modify: `packages/mcp/src/cli.ts`
- Test: extend `packages/mcp/src/cli.test.ts` (create if absent) or verify via `node dist/cli.js`

**Interfaces:**
- Produces: `vibe-mcp-server --local <dir> [--no-auto-commit]` starts a stdio server against the local workspace. `--local` and `--url` are mutually exclusive; missing both prints usage and exits 1. Local mode ignores `--token`/`--workspace`.

- [ ] **Step 1: Modify cli.ts**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLocalServer } from "./local/server.js";
import { createProxyServer, createRemoteTools } from "./proxy.js";
import { runProxy } from "./proxy-run.js";

const ENV_URL = "VIBE_BOX_URL";
const ENV_TOKEN = "VIBE_BOX_TOKEN";
const ENV_WORKSPACE = "VIBE_BOX_WORKSPACE";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1] !== undefined) {
    return process.argv[index + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function main(): void {
  const local = flagValue("--local");
  const url = flagValue("--url") ?? process.env[ENV_URL];
  const token = flagValue("--token") ?? process.env[ENV_TOKEN];
  const workspace = flagValue("--workspace") ?? process.env[ENV_WORKSPACE];

  if (local !== undefined && url !== undefined) {
    console.error("vibe-mcp-server: --local and --url are mutually exclusive");
    process.exit(1);
  }

  if (local !== undefined) {
    const server = createLocalServer({ root: local, autoCommit: !hasFlag("--no-auto-commit") });
    void mainLoop(server);
    return;
  }

  if (url === undefined) {
    console.error(
      `Missing MCP endpoint. Pass --url <url> (remote) or --local <dir> (local git workspace).\n` +
        `Usage: vibe-mcp-server --local <dir> [--no-auto-commit] | --url <url> [--token <token>] [--workspace <name>]`,
    );
    process.exit(1);
  }

  runProxy({ url, token, workspace }).catch((error: unknown) => {
    console.error("vibe-mcp-server failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function mainLoop(server: ReturnType<typeof createLocalServer>): Promise<void> {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("vibe-mcp-server failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Build + smoke test**

Run: `npm run build --workspace @vibe-box/mcp && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | timeout 5 node dist/cli.js --local /tmp 2>&1 | head -c 200`
Expected: initialize response frames on stdout (stdio JSON-RPC), no crash.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/src/cli.ts
git commit -m "mcp: add --local mode to the CLI"
```

---

### Task 5: Docs, full verification, commit

**Files:**
- Modify: `packages/mcp/README.md` — document `--local` mode, tool list, auto-commit policy, and the "not a repo degrades gracefully" behavior.
- Modify: root `README.md` — mention local mode in the mcp package bullet (optional, one line).

- [ ] **Step 1: Update README**

Document:
```
Local mode:  vibe-mcp-server --local <dir> [--no-auto-commit]
```
and the full tool list (10 tools) with the auto-commit table.

- [ ] **Step 2: Full workspace verification**

Run: `npm run build && npm run typecheck && npm test && npm run check`
Expected: all green (computerd FUSE test remains the known arm64 environment failure).

- [ ] **Step 3: Final commit**

```bash
git add packages/mcp/README.md README.md
git commit -m "mcp: document local git workspace mode"
```
