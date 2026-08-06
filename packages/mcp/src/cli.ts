#!/usr/bin/env node
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

function main(): void {
  const url = flagValue("--url") ?? process.env[ENV_URL];
  const token = flagValue("--token") ?? process.env[ENV_TOKEN];
  const workspace = flagValue("--workspace") ?? process.env[ENV_WORKSPACE];

  if (url === undefined) {
    console.error(
      `Missing MCP endpoint URL. Pass --url <url> or set ${ENV_URL}.\n` +
        `Usage: vibe-mcp-server --url <url> [--token <token>] [--workspace <name>]`,
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
