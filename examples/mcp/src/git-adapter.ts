// Git adapter for the remote MCP worker: wraps the workspace's
// GitClient in the McpGitSurface contract the MCP git tools speak.
// Authentication is injected server-side from worker env — never
// through MCP arguments, so tokens stay out of model context.

import type { McpGitSurface } from "@vibe-box/mcp";

export interface GitAdapterOptions {
  /** The workspace's git client (from getWorkspace(...).git). */
  git: {
    cli(input: {
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
    }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    push(options?: {
      remote?: string;
      ref?: string;
      force?: boolean;
      headers?: Record<string, string>;
    }): Promise<{ ok: boolean; error?: string }>;
    pull(options?: {
      remote?: string;
      ref?: string;
      headers?: Record<string, string>;
    }): Promise<void>;
    clone(options: { url: string; dir?: string; headers?: Record<string, string> }): Promise<void>;
  };
  /** Authorization header value, e.g. "Bearer <token>". */
  authorization?: string;
  /** Git identity for commit-producing operations. */
  identity?: { name: string; email: string };
}

export function createGitAdapter(options: GitAdapterOptions): McpGitSurface {
  const { git, authorization } = options;
  const headers = authorization !== undefined ? { Authorization: authorization } : undefined;
  const identityEnv: Record<string, string> =
    options.identity !== undefined
      ? {
          GIT_AUTHOR_NAME: options.identity.name,
          GIT_AUTHOR_EMAIL: options.identity.email,
          GIT_COMMITTER_NAME: options.identity.name,
          GIT_COMMITTER_EMAIL: options.identity.email,
        }
      : {};

  return {
    async run(argv) {
      const result = await git.cli({ argv, env: identityEnv });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    async push(opts) {
      const result = await git.push({ remote: opts?.remote, ref: opts?.ref, headers });
      if (!result.ok) {
        throw new Error(result.error ?? "push rejected");
      }
      return "(pushed)";
    },
    async pull(opts) {
      await git.pull({ remote: opts?.remote, ref: opts?.ref, headers });
      return "(pulled)";
    },
    async clone(opts) {
      await git.clone({ url: opts.url, dir: opts.dir, headers });
      return `cloned ${opts.url}`;
    },
  };
}
