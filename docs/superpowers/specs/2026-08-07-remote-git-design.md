# Remote Workspace Git Support — Design

Date: 2026-08-07

## Problem

The remote MCP worker (Cloudflare DO) serves file tools only — no git.
The flagship scenario — an online AI writes code into a remote
workspace, then a local machine pulls the work to keep developing —
needs the remote side to be a real Git repository.

The core engine already exists: `@vibe-box/computer/git` is a full
`GitClient` (40+ methods, argv-driven `cli`) running on the SQLite
VFS via isomorphic-git, documented to work on a filesystem-only
workspace. What is missing is the MCP surface that exposes it to
clients.

## Design

### One git surface, two adapters

`registerTools` gains a fourth parameter `git?: McpGitSurface`; when
present it registers six tools. Local mode and remote mode both speak
the same surface:

```ts
export interface McpGitSurface {
  /** argv-driven entry, e.g. ["log", "--oneline", "-n", "5"]. */
  run(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  push(opts?: { remote?: string; ref?: string }): Promise<string>;
  pull(opts?: { remote?: string; ref?: string }): Promise<string>;
  clone(opts: { url: string; dir?: string }): Promise<string>;
}
```

| Tool | Implementation |
| --- | --- |
| `git` | `surface.run(argv)` — full argv surface |
| `git_status` | `run(["status", "--short"])` |
| `git_log` | `run(["log", "--oneline", "-n", N])` |
| `git_commit` | `run(["commit", "-m", message])` after staging |
| `git_push` | `surface.push({ remote, ref })` |
| `git_pull` | `surface.pull({ remote, ref })` |
| `git_clone` | `surface.clone({ url, dir })` — the remote scenario entry point |

- **Local adapter**: `GitRunner` (git CLI) gains `run`/`push`/`pull`/
  `clone`. `createLocalServer` passes it and drops its hand-written
  git tools — one registration path for both modes.
- **Remote adapter**: wraps the workspace's `GitClient`, calling
  `cli({ argv, env })` for `run` and `pushWith`/`pullWith`/`cloneWith`
  with `headers` for network operations. Authentication is injected
  server-side from worker env — `GIT_USERNAME` / `GIT_TOKEN` —
  never through MCP arguments, so tokens never enter model context.

### Worker wiring (`examples/mcp`)

- `WorkspaceOptions.git = createGitClient({ ws, defaultIdentity })`,
  identity from `GIT_IDENTITY_NAME` / `GIT_IDENTITY_EMAIL` vars with
  a sensible fallback.
- The DO builds the remote adapter once and hands it to
  `createMcpServer` through the workspace's `git` field.
- `wrangler.jsonc`: optional `GIT_TOKEN` secret and
  `GIT_IDENTITY_NAME`/`GIT_IDENTITY_EMAIL` vars (no new plans —
  egress and the existing MCP route already work on Free).

### Authentication model

| Operation | Auth |
| --- | --- |
| `clone`/`push`/`pull` over https | `Authorization: Bearer <GIT_TOKEN>` header when `GIT_TOKEN` is set; anonymous otherwise (public repos) |
| Local mode | host git credentials, unchanged |

## Testing

- `tools.test.ts`: registering with a stub git surface exposes the
  six tools; `git_status`/`git_clone` route through the surface.
- `git.test.ts`: `GitRunner` run/push/pull/clone against a bare
  remote (push/pull already covered; add `run` and `clone`).
- `server.test.ts` (local): tool list grows to 13; the hand-written
  git tools are replaced by the shared ones (behavior unchanged).
- Remote adapter is exercised through the existing git suite's
  fixtures in `packages/computer` — no workerd test needed for the
  adapter shape; the example worker's typecheck covers wiring.

## Out of scope

- HTTP auth UI/flow (token stays a worker secret).
- Branch management tools beyond the shared six.
- Local-mode credential prompts.
