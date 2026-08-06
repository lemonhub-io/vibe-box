/**
 * Tool registration for the Vibe Box MCP server.
 *
 * The six tools mirror the AI SDK surface in `@vibe-box/computer/tools`
 * (read, ls, write, edit, exec, publish) so a model gets the same
 * workspace operations whether it drives the workspace through
 * `@cloudflare/agents` or through MCP. The workspace argument is a
 * structural contract: anything with `fs` (and, for exec, `runtime`)
 * works, which keeps the DO-side code free of the full Workspace type.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type McpToolResult = { content: TextContent[]; isError?: boolean };

const text = (text: string, isError = false): McpToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** A finite JSON value accepted as structured exec input. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface McpWorkspace {
  readonly sessionId?: string;
  fs: {
    stat(path: string): Promise<{
      size: number;
      mtime: number;
      mode: number;
      isFile: boolean;
      isDirectory: boolean;
    }>;
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    writeFile(path: string, content: Uint8Array, options?: { mode?: number }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  };
  runtime?: {
    exec(
      command: string,
      options: {
        cwd?: string;
        encoding: "utf8";
        backend?: string;
        env?: Record<string, string>;
        input?: JsonValue;
      },
    ): Promise<ExecHandle>;
  };
  assets?: {
    share(path: string, options: { expiresAfter: number; prefix?: string }): Promise<string>;
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === "ENOENT";
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encode(textValue: string): Uint8Array {
  return new TextEncoder().encode(textValue);
}

const DEFAULT_MAX_EDIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 60 * 1000;

interface ExecHandle {
  result(): Promise<{ exitCode: number; stdout: string; stderr: string; value?: unknown }>;
  kill?(): Promise<void>;
}

/**
 * Drain an exec handle's result, killing the command if it has not
 * settled within `timeoutMs`. Backends without a kill handle run
 * unguarded.
 */
async function execWithTimeout(
  handle: ExecHandle,
  timeoutMs: number,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; value?: unknown }> {
  const result = handle.result();
  if (handle.kill === undefined) return result;
  return Promise.race([
    result,
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
        void handle.kill!().catch(() => {});
      }, timeoutMs);
    }),
  ]);
}

/**
 * Read a file, capping the returned text at `maxBytes`. The whole
 * file is still read from the workspace so callers can tell a
 * truncation from a read error; only the MCP response is capped.
 */
async function readCapped(
  ws: McpWorkspace,
  path: string,
  maxBytes: number,
): Promise<McpToolResult> {
  const bytes = await readAll(await ws.fs.readFile(path));
  if (bytes.byteLength > maxBytes) {
    const kept = decode(bytes.slice(0, maxBytes));
    return text(
      `${kept}\n\n[truncated: file is ${bytes.byteLength} bytes; showing the first ${maxBytes}]`,
    );
  }
  return text(decode(bytes));
}

/**
 * Apply one exact replacement to a file, matching the AI edit tool's
 * contract: oldText must occur exactly once in the original content.
 * Errors (missing, ambiguous, empty, no-op) mirror the AI tool's
 * messages so models see the same guidance on both surfaces.
 */
async function applyEdit(
  ws: McpWorkspace,
  path: string,
  oldText: string,
  newText: string,
): Promise<McpToolResult> {
  if (oldText.length === 0) {
    return text(`oldText must not be empty in ${path}.`, true);
  }
  const stream = await ws.fs.readFile(path).catch((err: unknown) => {
    throw err;
  });
  const content = decode(await readAll(stream));
  if (content.length > DEFAULT_MAX_EDIT_BYTES) {
    return text(
      `File ${path} is larger than the ${DEFAULT_MAX_EDIT_BYTES}-byte edit cap; use write instead.`,
      true,
    );
  }
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    return text(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
      true,
    );
  }
  if (occurrences > 1) {
    return text(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
      true,
    );
  }
  const newContent = content.replace(oldText, newText);
  if (newContent === content) {
    return text(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
      true,
    );
  }
  await ws.fs.writeFile(path, encode(newContent));
  return text(`Edited ${path} (1 replacement).`);
}

export function registerTools(server: McpServer, workspace: McpWorkspace): void {
  server.tool(
    "read",
    "Read a file from the workspace and return its contents as text. Files larger than 1 MiB are truncated with a marker.",
    { path: z.string().describe("Absolute workspace path, e.g. /workspace/src/index.ts.") },
    async ({ path }) => {
      try {
        return await readCapped(workspace, path, DEFAULT_READ_MAX_BYTES);
      } catch (err) {
        if (isEnoent(err)) return text(`No such file: ${path}.`, true);
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.tool(
    "ls",
    "List entries in a workspace directory. Returns each entry name and whether it is a file or directory.",
    { path: z.string().describe("Absolute directory path, e.g. /workspace/src.") },
    async ({ path }) => {
      try {
        const entries = await workspace.fs.readdir(path);
        return text(
          JSON.stringify(
            {
              path,
              entries: entries.map((e) => ({
                name: e.name,
                isFile: e.isFile,
                isDirectory: e.isDirectory,
              })),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.tool(
    "write",
    "Write a file to the workspace, creating parent directories as needed. Overwrites existing content.",
    {
      path: z.string().describe("Absolute workspace path, e.g. /workspace/README.md."),
      content: z.string().describe("Full file content to write."),
    },
    async ({ path, content }) => {
      try {
        await workspace.fs.writeFile(path, encode(content));
        return text(`Wrote ${path} (${encode(content).byteLength} bytes).`);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.tool(
    "edit",
    "Apply a precise replacement to a file. oldText must appear exactly once in the file.",
    {
      path: z.string().describe("Absolute workspace path, e.g. /workspace/src/index.ts."),
      oldText: z
        .string()
        .describe(
          "Exact text to replace. Must be unique in the file, including whitespace and newlines.",
        ),
      newText: z.string().describe("Replacement text."),
    },
    async ({ path, oldText, newText }) => applyEdit(workspace, path, oldText, newText),
  );

  if (workspace.runtime !== undefined) {
    server.tool(
      "exec",
      "Run a shell command inside the workspace and return its exit code, stdout, and stderr.",
      {
        command: z.string().describe("Shell command to run."),
        cwd: z.string().optional().describe("Working directory inside the workspace."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Kill the command after this many milliseconds. Defaults to 60 seconds."),
      },
      async ({ command, cwd, timeoutMs }) => {
        try {
          const handle = await workspace.runtime!.exec(command, { encoding: "utf8", cwd });
          const result = await execWithTimeout(
            handle,
            timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
            command,
          );
          const parts = [`exit ${result.exitCode}`];
          if (result.stdout) parts.push(result.stdout);
          if (result.stderr) parts.push(`stderr: ${result.stderr}`);
          return text(parts.join("\n"));
        } catch (err) {
          return text(err instanceof Error ? err.message : String(err), true);
        }
      },
    );
  }

  if (workspace.assets !== undefined) {
    server.tool(
      "publish",
      "Publish a file from the workspace through the configured assets publisher and return a time-limited link.",
      {
        path: z.string().min(1).describe("Absolute workspace path, e.g. /workspace/out/chart.png."),
        expiresAfterMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Link lifetime in milliseconds. Defaults to one hour."),
      },
      async ({ path, expiresAfterMs }) => {
        try {
          const prefix = workspace.sessionId ? `agent-${workspace.sessionId}` : undefined;
          const url = await workspace.assets!.share(path, {
            expiresAfter: expiresAfterMs ?? 60 * 60 * 1000,
            ...(prefix ? { prefix } : {}),
          });
          return text(url);
        } catch (err) {
          return text(err instanceof Error ? err.message : String(err), true);
        }
      },
    );
  }
}
