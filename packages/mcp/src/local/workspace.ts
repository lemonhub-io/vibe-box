import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

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

/**
 * A structural `McpWorkspace` over a real directory: node:fs for the
 * filesystem half, child_process spawn for the runtime half. This is
 * the backing store for the `--local` mode — no Cloudflare, no SQLite,
 * just the working tree.
 */
export class LocalWorkspace implements McpWorkspace {
  constructor(readonly root: string) {}

  fs = {
    stat: async (path: string) => {
      const s = await stat(resolveWorkspacePath(this.root, path));
      return {
        size: s.size,
        mtime: s.mtimeMs,
        mode: s.mode,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
      };
    },
    readFile: async (path: string) => {
      const bytes = await readFile(resolveWorkspacePath(this.root, path));
      return toReadableStream(bytes);
    },
    writeFile: async (path: string, content: Uint8Array, options?: { mode?: number }) => {
      const target = resolveWorkspacePath(this.root, path);
      const parent = join(target, "..");
      if (parent !== resolve(this.root)) {
        await mkdir(parent, { recursive: true });
      }
      await writeFile(target, content, options);
    },
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      await mkdir(resolveWorkspacePath(this.root, path), { recursive: options?.recursive });
    },
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      await rm(resolveWorkspacePath(this.root, path), {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
    },
    readdir: async (path: string) => {
      const entries = await readdir(resolveWorkspacePath(this.root, path), {
        withFileTypes: true,
      });
      return entries.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    },
  };

  runtime = {
    exec: async (command: string, options: { cwd?: string; encoding: "utf8" }) => {
      const cwd =
        options.cwd === undefined ? this.root : resolveWorkspacePath(this.root, options.cwd);
      const child = spawn(command, { cwd, shell: "/bin/sh", stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolvePromise, rejectPromise) => {
          child.on("error", rejectPromise);
          child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
        },
      );
      return {
        result: () => result,
        kill: async () => {
          child.kill("SIGKILL");
        },
      };
    },
  };
}
