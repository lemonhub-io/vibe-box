# MCP Server for Vibe Box — Design

Date: 2026-08-06

## Problem

Vibe Box ships an AI SDK tool layer (`@vibe-box/computer/tools`) that
only works inside Cloudflare Workers through `@cloudflare/agents`.
Mainstream coding agents (Claude Code, opencode, Cursor) speak MCP and
run as local processes; they cannot reach a Durable Object directly.

Goal: expose the workspace's file and execution surface as MCP tools so
any MCP-capable agent can use a deployed Vibe Box workspace as its
working directory.

## Architecture

Two components, one protocol:

```
[MCP client] --stdio--> [local proxy CLI] --HTTP MCP JSON-RPC--> [DO: MCP server] --> Workspace
```

- The Durable Object hosts the real MCP server using the streamable
  HTTP transport from `@modelcontextprotocol/sdk`. It operates the
  `Workspace` object directly.
- The local proxy is a transport shim: an MCP stdio server that
  forwards JSON-RPC messages over HTTP to the DO endpoint. It carries
  no domain logic, so the same DO-side server can later be exposed
  directly over the public internet for clients with native remote MCP
  support.

## Tools

Aligned with `createAITools` in `@vibe-box/computer/tools`:

| Tool | Semantics |
| --- | --- |
| `read` | Read a file by path |
| `ls` | List a directory |
| `write` | Write a file |
| `edit` | Apply a precise string replacement |
| `exec` | Run a shell command through the workspace runtime |
| `publish` | Publish an artifact (only when the binding is present) |

The `readonly` mode is not part of the first version. Tools are
registered unconditionally, matching the general MCP consumer target.

## Components

### `packages/mcp` (new workspace package, `@vibe-box/mcp`)

- `src/server.ts` — `createMcpServer(workspace)`: registers the six
  tools on an MCP `Server` and exports helpers to serve it over
  streamable HTTP (request handler suitable for a DO fetch).
- `src/proxy.ts` — stdio MCP server that forwards to the DO endpoint
  over HTTP with `Authorization: Bearer <token>`.
- `bin/mcp-server.mjs` — CLI entry: `--url`, `--token`,
  `--workspace <name>`, defaulting to environment variables
  (`VIBE_BOX_URL`, `VIBE_BOX_TOKEN`, `VIBE_BOX_WORKSPACE`).
- Depends on `@modelcontextprotocol/sdk`, `@vibe-box/computer`, zod.

### `examples/mcp` (new example Worker)

- Durable Object with the streamable HTTP MCP endpoint, workspace
  construction copied from `examples/container`.
- `wrangler.toml` with an `MCP_TOKEN` secret and a `MCP_WORKSPACE`
  variable.
- README documenting how to point the proxy at a deployed worker.

## Auth and configuration

- DO endpoint rejects requests without `Authorization: Bearer` matching
  `env.MCP_TOKEN`.
- Local CLI reads URL, token, and workspace name from flags or the
  `VIBE_BOX_*` environment variables.

## Testing

- Unit tests for the DO-side server: tool calls against an in-memory
  workspace through the SDK client, covering read/ls/write/edit/exec
  success and error paths.
- The example worker's HTTP surface is verified through
  `vitest-pool-workers` following the existing example test pattern.
- Manual verification with a standard MCP client through the proxy.

## Out of scope (first version)

- Resources and prompts (tools only).
- OAuth; bearer token only.
- Multi-workspace switching; one workspace name per proxy invocation.
- Read-only mode.
