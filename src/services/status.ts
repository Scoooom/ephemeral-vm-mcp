import type { AppContext } from "../context.js";
import type { VmRow } from "../db/repo.js";
import type { PveLxcStatus } from "../proxmox/types.js";
import { requireOwnedVm } from "./ownership.js";

export interface VmStatusReport {
  db: VmRow;
  proxmox: PveLxcStatus | { error: string };
  drift: string[];
}

/**
 * Live Proxmox status for an owned container plus its local DB record, with any
 * divergence between the two flagged. Shared by the `get_vm_status` MCP tool and
 * the dashboard's per-container detail view.
 */
export async function vmStatusWithDrift(ctx: AppContext, vmid: number): Promise<VmStatusReport> {
  const row = requireOwnedVm(ctx, vmid);
  const live = await ctx.pve.lxc.getStatus(vmid).catch((e) => ({ error: String(e) }));

  const drift: string[] = [];
  if ("status" in live) {
    if (live.status === "running" && !["running", "task_running"].includes(row.status)) {
      drift.push(`Proxmox says running, DB says ${row.status}`);
    }
    if (live.status === "stopped" && ["running", "task_running"].includes(row.status)) {
      drift.push(`Proxmox says stopped, DB says ${row.status}`);
    }
  }

  return { db: row, proxmox: live, drift };
}
