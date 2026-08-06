# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@vibe-box/mcp` — a streamable-HTTP MCP server hosted on a Durable Object plus a local stdio proxy CLI — exposing read/ls/write/edit/exec/publish over MCP.

**Architecture:** The DO hosts the real MCP server (McpServer + StreamableHTTPServerTransport from `@modelcontextprotocol/sdk`) operating on a `Workspace` directly. A local `mcp-server` CLI is a stdio MCP server that lazily connects to the remote DO endpoint and forwards tools/list and tools/call. Bearer-token auth on the DO endpoint.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@^1.30.0`, `@vibe-box/computer`, `@vibe-box/dofs/testing` (SQLiteTestStorage), vitest, wrangler.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-mcp-design.md` — tools only; no resources/prompts; bearer token only; one workspace name per proxy invocation; no readonly mode.
- Repo conventions: `type: module` ESM everywhere; `tsc -p tsconfig.build.json` build; vitest for tests; biome for format/lint; commit scoped per repo AGENTS.md (`mcp:`, `examples/mcp:`).
- New packages go into root `package.json` workspaces (npm workspaces list).
- DO code runs in workerd: `nodejs_compat` flag; no Node-only APIs in DO-side code (streamable HTTP transport must work with the Fetch API).
- Proxy CLI runs in plain Node; may use Node APIs.
- Package must build with `tsc` (no bundler) and keep typecheck green (`npm run typecheck`).

---

### Task 1: `packages/mcp` package skeleton

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/tsconfig.build.json`
- Create: `packages/mcp/vitest.config.ts`
- Modify: `package.json` (root workspaces)
- Create: `packages/mcp/src/index.ts`

**Interfaces:**
- Produces: package `@vibe-box/mcp` with exports `.` (index), scripts `build` (`tsc -p tsconfig.build.json`), `typecheck` (`tsc -p tsconfig.build.json --noEmit`), `test` (`vitest run`); depends on `@modelcontextprotocol/sdk` and `@vibe-box/computer`; devDeps `@vibe-box/dofs`, `typescript`, `vitest`, `@cloudflare/workers-types`, `@types/node`, `zod`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@vibe-box/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "types": "./dist/index.d.ts",
  "bin": {
    "vibe-mcp-server": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.build.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@vibe-box/computer": "*",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260616.1",
    "@types/node": "^25.9.1",
    "@vibe-box/dofs": "*",
    "typescript": "^6.0.3",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "ESNext.Disposable", "WebWorker"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": [
      "@cloudflare/workers-types",
      "vitest/globals",
      "node"
    ]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": false,
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Register the workspace in root package.json**

Add `"packages/mcp"` to the `workspaces` array in `/root/projects/gh/vibe-box/package.json` (after `"packages/computerd"`).

- [ ] **Step 6: Create src/index.ts stub**

```ts
export {};
```

- [ ] **Step 7: Verify skeleton**

Run: `npm install && npm run build --workspace @vibe-box/mcp`
Expected: builds clean; `dist/index.js` exists.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json packages/mcp
git commit -m "mcp: scaffold @vibe-box/mcp package"
```

---

### Task 2: DO-side MCP server (`createMcpServer`)

**Files:**
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/tools.ts`
- Modify: `packages/mcp/src/index.ts`

**Interfaces:**
- Produces:
  - `createMcpServer(workspace: McpWorkspace): McpServer` where `McpWorkspace` is the structural `WorkspaceLike` from `@vibe-box/computer/tools` plus a `runtime` for exec.
  - `server.ts` re-exports `createMcpServer`.
  - Tools registered with exact names and semantics from the design spec: `read`, `ls`, `write`, `edit`, `exec`, `publish`.

- [ ] **Step 1: Write failing test** `packages/mcp/src/tools.test.ts`

Test file asserts a McpServer with a stub workspace registers the six tool names and their `listTools()` output contains read/ls/write/edit/exec/publish.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @vibe-box/mcp`
Expected: FAIL (module `./tools.js` not found).

- [ ] **Step 3: Implement tools.ts**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { WorkspaceLike } from "@vibe-box/computer/tools";
```

`registerTools(server: McpServer, workspace: McpWorkspace)` registers:
- `read` — `{ path: z.string() }`; reads via `WorkspaceFileStore.readAll`, returns text or error content.
- `ls` — `{ path: z.string() }`; `fs.readdir`, returns JSON of entries.
- `write` — `{ path: z.string(), content: z.string() }`; `store.write`.
- `edit` — `{ path: z.string(), oldText: z.string(), newText: z.string() }`; reuse `applyEditsToNormalizedContent` from `@vibe-box/computer/tools` internal edit-diff via exported helper (see note below), or implement minimal exact-replace with uniqueness check matching tools/fs/edit.ts semantics.
- `exec` — `{ command: z.string(), cwd: z.string().optional() }`; `workspace.runtime.exec(command, { encoding: "utf8", cwd })`, drain `handle.result()` and return `{ exitCode, stdout, stderr }` as text.
- `publish` — `{ name: z.string().optional(), ... }`; only when `workspace.artifacts !== undefined`, else skip registration (do not register the tool when the binding is absent).

Note: `edit-diff.ts` is not exported from `@vibe-box/computer`; implement edit as: read file, check uniqueness of oldText (error when 0 or >1 occurrences), replace, write back — matching the AI tool's documented semantics.

- [ ] **Step 4: Implement server.ts**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createMcpServer(workspace: McpWorkspace): McpServer {
  const server = new McpServer({ name: "vibe-box", version: "0.1.0" });
  registerTools(server, workspace);
  return server;
}
```

- [ ] **Step 5: Export from index.ts**

```ts
export { createMcpServer, type McpWorkspace } from "./server.js";
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace @vibe-box/mcp`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp
git commit -m "mcp: register workspace tools on MCP server"
```

---

### Task 3: Streamable HTTP fetch handler

**Files:**
- Create: `packages/mcp/src/streamable-http.ts`
- Modify: `packages/mcp/src/index.ts`

**Interfaces:**
- Produces: `createFetchHandler(server: McpServer): (request: Request) => Promise<Response>` implementing MCP streamable HTTP transport via `StreamableHTTPServerTransport`, including the required GET/POST/DELETE handling and auth-free (auth applied by caller).

- [ ] **Step 1: Write failing test** `packages/mcp/src/streamable-http.test.ts`

Using the SDK `Client` + `StreamableHTTPClientTransport` pointed at a `createFetchHandler`-wrapped server, assert: `initialize` + `listTools()` returns the six tool names; `callTool` on `write` + `read` round-trips a file in a stub workspace.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @vibe-box/mcp`
Expected: FAIL (module `./streamable-http.js` not found).

- [ ] **Step 3: Implement streamable-http.ts**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function createFetchHandler(
  server: McpServer,
): (request: Request) => Promise<Response> {
  let transport: StreamableHTTPServerTransport | undefined;
  return async (request: Request) => {
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await server.connect(transport);
    }
    return transport.handleRequest(request, request.body, request.headers);
  };
}
```

- [ ] **Step 4: Export from index.ts**

```ts
export { createFetchHandler } from "./streamable-http.js";
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace @vibe-box/mcp`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp
git commit -m "mcp: add streamable HTTP fetch handler"
```

---

### Task 4: Local stdio proxy CLI

**Files:**
- Create: `packages/mcp/src/proxy.ts`
- Create: `packages/mcp/src/cli.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/mcp/package.json` (bin path)

**Interfaces:**
- Produces:
  - `runProxy(options: { url: string; token?: string; workspace: string }): Promise<void>` — stdio MCP server (`Server` from `@modelcontextprotocol/sdk/server/index.js`, `StdioServerTransport`) that lazily connects a `Client` to the remote URL with `Authorization: Bearer <token>` and forwards `tools/list` and `tools/call`.
  - CLI: `vibe-mcp-server` binary reading flags `--url`, `--token`, `--workspace` with env fallbacks `VIBE_BOX_URL`, `VIBE_BOX_TOKEN`, `VIBE_BOX_WORKSPACE`. Workspace name is passed as a query parameter `?workspace=<name>` on the remote URL.

- [ ] **Step 1: Write failing test** `packages/mcp/src/proxy.test.ts`

Spin a local `http.createServer` that answers `GET/POST` with a minimal stub MCP streamable-HTTP endpoint (echo tools/list with one tool). Run `runProxy` with `url` pointed at the stub, drive the stdio server in-process (connect a `Client` via an in-memory transport or spawn the CLI with `node dist/cli.js`), assert `listTools` round-trips.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @vibe-box/mcp`
Expected: FAIL (module `./proxy.js` not found).

- [ ] **Step 3: Implement proxy.ts**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

- [ ] **Step 4: Implement cli.ts**

Parse `process.argv`, resolve options from flags or env, call `runProxy`, log errors to stderr and exit 1 on failure. Bin points at `./dist/cli.js`.

- [ ] **Step 5: Build + run tests**

Run: `npm run build --workspace @vibe-box/mcp && npm test --workspace @vibe-box/mcp`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp
git commit -m "mcp: add local stdio proxy CLI"
```

---

### Task 5: `examples/mcp` Worker + Durable Object

**Files:**
- Create: `examples/mcp/package.json`
- Create: `examples/mcp/tsconfig.json`
- Create: `examples/mcp/wrangler.jsonc`
- Create: `examples/mcp/src/index.ts`
- Create: `examples/mcp/README.md`

**Interfaces:**
- Produces: `@example/vibe-mcp` worker; `MCP_DO` Durable Object class owning one Workspace (storage + no backend for filesystem-only, or a WorkerShell backend); fetch route `POST/GET/DELETE /mcp` on the top-level Worker that auth-checks `Authorization: Bearer <env.MCP_TOKEN>` then delegates to `createFetchHandler`.

- [ ] **Step 1: Write failing test** `examples/mcp/src/index.test.ts`

Using `@cloudflare/vitest-pool-workers`, drive the Worker's fetch handler: unauthorized request → 401; authorized `POST /mcp` initialize → 200 and tools listed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @example/vibe-mcp`
Expected: FAIL (module or route missing).

- [ ] **Step 3: Implement src/index.ts**

Follow `examples/container/src/index.ts` structure: `DurableObject` subclass, `Workspace` constructed with `{ storage, backends: [] }`, `createMcpServer(ws)` + `createFetchHandler(server)`; top-level `fetch` checks the bearer token then calls the handler.

- [ ] **Step 4: Create wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "vibe-box-mcp-example",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-26",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "MCP_DO", "class_name": "MCPDo" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MCPDo"] }
  ],
  "vars": { "MCP_WORKSPACE": "default" },
  "observability": { "traces": { "enabled": true } }
}
```

- [ ] **Step 5: Create package.json + tsconfig.json** mirroring `examples/worker-shell` (scripts: dev/deploy/typecheck; devDeps: wrangler, typescript, @cloudflare/workers-types, vitest, @cloudflare/vitest-pool-workers).

- [ ] **Step 6: Write README.md** documenting deploy (`wrangler deploy`), setting `MCP_TOKEN` (`wrangler secret put MCP_TOKEN`), and running the proxy (`npx @vibe-box/mcp --url https://<worker>/mcp --token <token>`).

- [ ] **Step 7: Verify**

Run: `npm install && npm run typecheck --workspace @example/vibe-mcp && npm test --workspace @example/vibe-mcp`
Expected: typecheck clean; tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json examples/mcp
git commit -m "examples/mcp: add MCP example worker"
```

---

### Task 6: Docs, full verification, commit

**Files:**
- Modify: `docs/README.md` (repo-level) — add `@vibe-box/mcp` to the package list.
- Modify: `packages/mcp/README.md` (create) — usage, auth, proxy invocation.

- [ ] **Step 1: Update docs**

Add `packages/mcp` (`@vibe-box/mcp`) to the repository layout list in `docs/README.md`; create `packages/mcp/README.md` with install, DO wiring, and proxy usage.

- [ ] **Step 2: Full workspace verification**

Run: `npm run build && npm run typecheck && npm test && npm run check`
Expected: all green (note: computerd FUSE test is expected to fail in this arm64 environment; the rest must pass).

- [ ] **Step 3: Final commit**

```bash
git add docs packages/mcp/README.md
git commit -m "mcp: document @vibe-box/mcp usage"
```
