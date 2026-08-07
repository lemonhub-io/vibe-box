# Local Git Workspace — Design

Date: 2026-08-07

## Problem

The Cloudflare Free plan cannot run the `exec` tool (Dynamic Workers
need the paid plan), and the hybrid "remote files + local mirror"
approach suffers from dual-authority consistency problems. The
simplest fix that also solves versioning and multi-agent
collaboration is to make the local workspace a Git working tree:
files, exec, and git all live on the local machine, with GitHub (or
any git remote) as the sync target. No paid plan, no custom sync
engine.

## Architecture

```
[MCP client] ──stdio──► [vibe-mcp-server --local <dir>]
                            ├── read/ls/write/edit ──► local working tree (node:fs)
                            ├── exec ────────────────► local spawn, cwd = working tree
                            └── git_status/commit/push/pull ──► git CLI
                                                                    │
                                                                    ▼
                                                              remote (GitHub, free)
```

The server runs entirely locally; the remote mode (streamable HTTP
to a deployed worker) is untouched. `--local` starts the same stdio
surface with a local workspace backing it, plus the git tool set.

## Tools

Existing file tools operate against the local directory unchanged
(read, ls, write, edit, exec — exec now runs because it is local
spawn). New tools:

| Tool | Semantics |
| --- | --- |
| `git_status` | Short status of the working tree |
| `git_commit` | Commit all staged changes with a message |
| `git_push` | Push current branch to its remote |
| `git_pull` | Pull from the remote |
| `git_log` | Recent commits (default 10) |

Git operations run through the `git` CLI (available on any dev
machine) with the working tree as `cwd`; credentials come from the
user's normal git configuration. The repository must already exist
(`git init` and remote setup are host-side, outside the server).

## Auto-commit policy

Agent workflows mutate files in many small steps. To keep the tree
durable and the git history meaningful without demanding explicit
commits:

- After a successful `write` or `edit`, commit the touched file
  automatically with message `mcp: write <path>` / `mcp: edit <path>`.
- After a successful `exec`, commit all changes with message
  `mcp: exec <first 80 chars of command>`.
- Reads, `ls`, `git_*` tools never commit.
- `--no-auto-commit` disables all of the above; agents then drive
  `git_commit` explicitly.
- If the directory is not a git repository, auto-commit is a no-op
  and file tools still work.

## Components

### `packages/mcp/src/local/workspace.ts`

`LocalWorkspace` — the structural `McpWorkspace` implementation over
a local directory:

- `fs` adapter: `node:fs/promises` → the McpWorkspace fs contract
  (stat/readFile as ReadableStream/writeFile/mkdir/rm/readdir);
  paths are rooted at the workspace directory, absolute workspace
  paths (`/workspace/...`) map to the root.
- `runtime.exec`: `child_process.spawn` with cwd = workspace root,
  capturing stdout/stderr, honoring the existing timeout/kill
  contract, no shell sandbox (documented limitation).

### `packages/mcp/src/local/git.ts`

`GitRunner` — thin `git` CLI wrapper: `status`, `commit`, `push`,
`pull`, `log`, plus `isRepo()` (`.git` exists) and
`commitAll(message)` used by the auto-commit hook. Commands run
without a shell, output captured, exit code surfaced.

### `packages/mcp/src/local/server.ts`

`createLocalServer(options)`:

- `root: string` — working tree directory
- `autoCommit?: boolean` (default true)
- Builds `LocalWorkspace`, registers the five file tools through
  `registerTools`, then registers the five `git_*` tools.
- Wraps write/edit/exec handlers to run the auto-commit hook after
  success.

### CLI (`cli.ts`)

`vibe-mcp-server --local <dir> [--no-auto-commit]` — starts the
stdio server against the local workspace and never contacts a
remote. Existing `--url/--token/--workspace` remote mode is
unchanged. Local mode requires `--local` and errors if the flag set
is ambiguous.

## Testing

- `git.test.ts`: GitRunner against a temp dir initialized with
  `git init` (and a bare remote for push/pull): commit/push/pull/log
  round trips.
- `local-server.test.ts`: full MCP client round trip against
  `createLocalServer` over an in-memory transport: write → exec →
  git_status → git_log; auto-commit on; auto-commit off; non-repo
  directory degrades gracefully.
- CLI smoke test: `--local` starts and lists the expected ten tools.

## Out of scope

- git init / remote setup (host-side).
- File watching for external changes; status is read on demand.
- Branch management (checkout/merge) beyond push/pull of the current
  branch.
- Sandboxing of exec (documented as a local-shell limitation).
- Remote mode changes (server worker, proxy) — untouched.
