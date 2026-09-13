import type { AppContext } from "../context.js";
import type { VmRow } from "../db/repo.js";
import { OWNER } from "../db/repo.js";

/** A caller-visible failure that carries a recovery hint. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * The ownership boundary. Every code path that mutates or inspects a specific
 * container resolves it through here: it must exist in `vms` as an active
 * `ephemeral-mcp` row. This is what stops any tool — or the web dashboard —
 * from being pointed at a production container (CT100 vpn, CT105 dns, the
 * CT113 template, ...).
 *
 * Lives in the service layer so both the MCP tools and the web API share the
 * exact same guard.
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
