import type { AppContext } from "../context.js";
import { execProxmoxTask } from "../proxmox/tasks.js";
import { requireOwnedVm } from "./ownership.js";

/**
 * Container power/teardown operations, shared by the MCP tools
 * (`start_vm` / `stop_vm` / `reboot_vm` / `destroy_vm`) and the web API.
 *
 * Every function resolves the target through `requireOwnedVm` first, so neither
 * surface can act on a container this server did not create. Each blocks until
 * the underlying Proxmox task finishes, then reconciles the DB row.
 */

export async function startVm(ctx: AppContext, vmid: number): Promise<"running"> {
  const row = requireOwnedVm(ctx, vmid);
  const upid = await ctx.pve.lxc.start(vmid);
  await execProxmoxTask(ctx.pve.client, upid, { timeoutMs: 120_000 });
  ctx.repo.setStatus(row.id, "running");
  return "running";
}

export async function stopVm(ctx: AppContext, vmid: number): Promise<"stopped"> {
  const row = requireOwnedVm(ctx, vmid);
  const upid = await ctx.pve.lxc.shutdown(vmid);
  await execProxmoxTask(ctx.pve.client, upid, { timeoutMs: 120_000 });
  ctx.repo.setStatus(row.id, "stopped");
  return "stopped";
}

export async function rebootVm(ctx: AppContext, vmid: number): Promise<"running"> {
  const row = requireOwnedVm(ctx, vmid);
  const upid = await ctx.pve.lxc.reboot(vmid);
  await execProxmoxTask(ctx.pve.client, upid, { timeoutMs: 180_000 });
  ctx.repo.setStatus(row.id, "running");
  return "running";
}

export interface DestroyResult {
  vmid: number;
  ip: string | null;
}

export async function destroyVm(ctx: AppContext, vmid: number): Promise<DestroyResult> {
  const row = requireOwnedVm(ctx, vmid);
  ctx.repo.setStatus(row.id, "tearing_down");

  const live = await ctx.pve.lxc.getStatus(vmid).catch(() => null);
  if (live?.status === "running") {
    const stopUpid = await ctx.pve.lxc.stop(vmid);
    await execProxmoxTask(ctx.pve.client, stopUpid, { timeoutMs: 120_000 });
  }

  const destroyUpid = await ctx.pve.lxc.destroy(vmid);
  await execProxmoxTask(ctx.pve.client, destroyUpid, { timeoutMs: 300_000 });

  ctx.repo.markDestroyed(row.id);
  return { vmid, ip: row.ip };
}
