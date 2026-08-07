import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerTools } from "../tools.js";
import { GitRunner } from "./git.js";
import { LocalWorkspace } from "./workspace.js";

export interface LocalServerOptions {
  /** Working tree directory the server operates on. */
  root: string;
  /** Auto-commit after write/edit/exec. Defaults to true. */
  autoCommit?: boolean;
}

/**
 * Build an MCP server over a local Git working tree. Twelve tools —
 * the five file/exec tools plus seven git tools — run entirely
 * locally; nothing touches a remote. The workspace does not need to
 * be a Git repository: file tools work regardless and auto-commit
 * degrades to a no-op.
 */
export function createLocalServer(options: LocalServerOptions): McpServer {
  const root = options.root;
  const autoCommit = options.autoCommit ?? true;
  const git = new GitRunner(root);
  const server = new McpServer({ name: "vibe-box-local", version: "0.1.0" });

  // Auto-commit hook: stage and commit everything, returning a note
  // only when something went wrong (a failed commit after a
  // successful tool call is a warning, not an error).
  const commit = async (message: string): Promise<string> => {
    if (!autoCommit) return "";
    if (!(await git.isRepo())) return "";
    try {
      const out = await git.commitAll(message);
      return out === "" ? "" : "";
    } catch (err) {
      return `[auto-commit failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  registerTools(
    server,
    new LocalWorkspace(root),
    autoCommit
      ? {
          afterWrite: (path) => commit(`mcp: write ${path}`),
          afterEdit: (path) => commit(`mcp: edit ${path}`),
          afterExec: (command, exitCode) =>
            exitCode === 0 ? commit(`mcp: exec ${command.slice(0, 80)}`) : Promise.resolve(""),
        }
      : undefined,
    git,
  );

  return server;
}
