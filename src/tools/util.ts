import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import { requireOwnedVm, sanitizeHostname, ToolError } from "../services/ownership.js";

// Re-exported so the existing `import { ... } from "./util.js"` call sites in
// the tool layer keep working; the definitions now live in the service layer
// where the web API can share them.
export { requireOwnedVm, sanitizeHostname, ToolError };

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wrap a tool handler so thrown errors become `isError` results rather than
 * protocol-level exceptions, and every call is logged to stderr.
 */
export function handler<A>(
  name: string,
  fn: (args: A, ctx: AppContext) => Promise<CallToolResult>,
  ctx: AppContext,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      logger.info(`tool ${name}`, args);
      return await fn(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`tool ${name} failed`, err);
      return errorResult(`${name} failed: ${msg}`);
    }
  };
}

/** Truncate long command output for the tool response; full text still goes to vm_logs. */
export function clip(text: string, max = 8_000): string {
  if (text.length <= max) return text;
  return `…[${text.length - max} chars truncated — full output in vm_logs]\n` + text.slice(-max);
}
