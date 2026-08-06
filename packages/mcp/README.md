# `@vibe-box/mcp`

MCP server for Vibe Box: exposes a workspace's file and execution
surface to any MCP-capable agent.

Two pieces, one protocol:

- **DO-side server** (`createMcpServer` + `createFetchHandler`): a
  streamable-HTTP MCP server that operates a `Workspace` directly.
  Wire it into a Durable Object's `fetch` and the workspace speaks
  MCP.
- **Local proxy** (`vibe-mcp-server`): a stdio MCP server that
  forwards its tool surface to a remote endpoint. Agents run as local
  processes, so the proxy is the bridge between their stdio transport
  and the deployed worker's HTTP endpoint.

```
MCP client ──► vibe-mcp-server (stdio) ──► Worker /mcp (streamable HTTP) ──► Workspace
```

## Tools

| Tool | Semantics |
| --- | --- |
| `read` | Read a file by path |
| `ls` | List a directory |
| `write` | Write a file |
| `edit` | Apply one exact replacement |
| `exec` | Run a shell command through the workspace runtime (only when the workspace has one) |
| `publish` | Publish an artifact through the assets client (only when present) |

## Server (on a Durable Object)

```ts
import { createFetchHandler, createMcpServer } from "@vibe-box/mcp";

// Inside your Durable Object's fetch:
const ws = await getWorkspace(this);
const handler = createFetchHandler(createMcpServer(ws));
return handler(request);
```

Auth, routing, and workspace selection are the caller's concern — the
example worker (`examples/mcp`) shows the full wiring with a bearer
token. DO-side code uses the web-standard transport, so it runs
unmodified inside workerd.

## Proxy (local CLI)

```sh
vibe-mcp-server --url https://worker.example.com/mcp --token <token> [--workspace default]
```

Flags fall back to the `VIBE_BOX_URL`, `VIBE_BOX_TOKEN`, and
`VIBE_BOX_WORKSPACE` environment variables. The workspace name is
sent as `?workspace=<name>` on the endpoint URL.

Register the command as an MCP stdio server in your client's config:

```json
{
  "mcpServers": {
    "vibe-box": {
      "command": "vibe-mcp-server",
      "args": ["--url", "https://worker.example.com/mcp", "--token", "<token>"]
    }
  }
}
```

## Development

```sh
npm test --workspace @vibe-box/mcp
npm run typecheck --workspace @vibe-box/mcp
```
