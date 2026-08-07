#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLocalServer } from "./local/server.js";
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

async function serve(server: ReturnType<typeof createLocalServer>): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
    const server = createLocalServer({
      root: local,
      autoCommit: !hasFlag("--no-auto-commit"),
    });
    serve(server).catch((error: unknown) => {
      console.error(
        "vibe-mcp-server failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
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
    console.error(
      "vibe-mcp-server failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}

main();
