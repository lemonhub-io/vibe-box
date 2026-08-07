// Hand-written env shape for the platform Worker. Run
// `wrangler types` to regenerate from wrangler.jsonc when the
// bindings change.

interface Env {
  MCP_DO: DurableObjectNamespace<import("./src/index.js").MCPDo>;
  MCP_WORKSPACE: string;
  MCP_TOKEN: string;
  LOADER: WorkerLoader;
}
