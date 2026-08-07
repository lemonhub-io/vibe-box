# MCP Example

Example Worker + Durable Object exposing a `@vibe-box/computer`
Workspace through the [MCP](https://modelcontextprotocol.io)
protocol.

The DO owns one Workspace whose shell runs in a Dynamic Worker
(just-bash through the Worker Loader), and answers MCP streamable-HTTP
requests on the top-level worker's `/mcp` route. Access is gated by a
bearer token: every request must carry
`Authorization: Bearer <MCP_TOKEN>`.

```
MCP client ──► vibe-mcp-server (local stdio proxy)
                   │  HTTP JSON-RPC (streamable)
                   ▼
           Worker /mcp ──► MCPDo DO ──► Workspace (SQLite fs)
```

## Deploy

```sh
npm install
npm run deploy --workspace @example/vibe-mcp
wrangler secret put MCP_TOKEN --remote   # from examples/mcp
```

The worker is reachable at `https://mcp.openos.channel/mcp`.

## Connect an agent

Run the local stdio proxy (from `@vibe-box/mcp`):

```sh
npx @vibe-box/mcp \
  --url https://mcp.openos.channel/mcp \
  --token <MCP_TOKEN> \
  --workspace default
```

Point your MCP client (Claude Code, opencode, Cursor, ...) at the
`vibe-mcp-server` command. The proxy forwards `tools/list` and
`tools/call` to the workspace; the client sees the six tools
`read`, `ls`, `write`, `edit`, `exec`, `publish` (the last one only
when the workspace has an assets client).

## Workspaces

The worker addresses the DO by name (`MCP_WORKSPACE`, default
`default`). Several workspaces can coexist behind one worker; the
proxy picks one with `--workspace <name>` or `VIBE_BOX_WORKSPACE`.

## Local development

```sh
npm run dev --workspace @example/vibe-mcp
```

with `MCP_TOKEN` set as a local secret:

```sh
wrangler secret put MCP_TOKEN   # from examples/mcp, local environment
```

Then point the proxy at `http://localhost:8787/mcp`.
