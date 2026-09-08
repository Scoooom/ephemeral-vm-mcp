import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../context.js";
import type { VmRow } from "../db/repo.js";
import { OWNER } from "../db/repo.js";
import { logger } from "../logger.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** A tool-visible failure that carries a recovery hint. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
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

/** Lowercase, DNS-safe hostname derived from a free-text name. */
export function sanitizeHostname(name: string): string {
  const h = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!h) throw new ToolError(`Name '${name}' has no usable characters for a hostname`);
  return h;
}

/**
 * The ownership boundary. Every tool that mutates or inspects a specific
 * container resolves it through here: it must exist in `vms` as an active
 * `ephemeral-mcp` row. This is what stops any tool from being pointed at a
 * production container (CT100 vpn, CT105 dns, the CT113 template, ...).
 */
export function requireOwnedVm(ctx: AppContext, vmid: number): VmRow {
  const row = ctx.repo.getActiveByVmid(vmid);
  if (!row || row.owned_by !== OWNER) {
    throw new ToolError(
      `Refusing to act on CT ${vmid}: not an active ${OWNER}-managed container. ` +
        `Use list_active_vms to see what this server manages.`,
    );
  }
  return row;
}

/** Truncate long command output for the tool response; full text still goes to vm_logs. */
export function clip(text: string, max = 8_000): string {
  if (text.length <= max) return text;
  return `…[${text.length - max} chars truncated — full output in vm_logs]\n` + text.slice(-max);
}
