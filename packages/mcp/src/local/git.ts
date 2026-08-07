import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { McpGitSurface } from "../tools.js";

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

function run(
  cwd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          code: typeof error.code === "number" ? error.code : null,
          stdout,
          stderr,
        });
      } else {
        resolve({ code: 0, stdout, stderr });
      }
    });
  });
}

/**
 * Thin wrapper over the `git` CLI for the local workspace server.
 * Commands run without a shell; the working tree is the workspace
 * root. Credentials and remotes come from the host's git config.
 */
export class GitRunner implements McpGitSurface {
  constructor(private readonly cwd: string) {}

  async isRepo(): Promise<boolean> {
    try {
      await access(join(this.cwd, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  private async runOrThrow(args: string[], what: string): Promise<string> {
    const { code, stdout, stderr } = await run(this.cwd, args);
    if (code !== 0) {
      throw new GitError(
        `${what} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
        code,
        stdout,
        stderr,
      );
    }
    return stdout.trim();
  }

  async status(): Promise<string> {
    return this.runOrThrow(["status", "--short"], "git status");
  }

  async commitAll(message: string): Promise<string> {
    await this.runOrThrow(["add", "-A"], "git add");
    return this.runOrThrow(["commit", "-m", message], "git commit");
  }

  async log(maxCount = 10): Promise<string> {
    return this.runOrThrow(["log", "--oneline", `-n ${maxCount}`], "git log");
  }

  // ---- McpGitSurface -------------------------------------------------

  async run(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { code, stdout, stderr } = await run(this.cwd, argv);
    return { stdout, stderr, exitCode: code ?? 1 };
  }

  async push(opts?: { remote?: string; ref?: string }): Promise<string> {
    // -u sets the upstream on first push, so a fresh clone with no
    // tracking branch works; it is a no-op when upstream exists.
    const args = ["push", "-u", opts?.remote ?? "origin", opts?.ref ?? "HEAD"];
    return this.runOrThrow(args, "git push");
  }

  async pull(opts?: { remote?: string; ref?: string }): Promise<string> {
    const args = ["pull", "--ff-only", opts?.remote ?? "origin", ...(opts?.ref ? [opts.ref] : [])];
    return this.runOrThrow(args, "git pull");
  }

  async clone(opts: { url: string; dir?: string }): Promise<string> {
    const args = ["clone", ...(opts.dir ? [opts.dir] : []), opts.url];
    return this.runOrThrow(args, "git clone");
  }
}
