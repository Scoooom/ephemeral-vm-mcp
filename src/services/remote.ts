import type { AppContext } from "../context.js";
import type { VmRow } from "../db/repo.js";
import { execCommand, type ExecOptions, type ExecResult } from "../ssh/exec.js";
import { requireOwnedVm, ToolError } from "./ownership.js";

/**
 * Resolve an owned container's IPv4: the DB row's `ip` first, then the live
 * Proxmox container netns as a fallback. Shared by every code path that needs
 * to SSH into a container (`exec_command`, `deploy_app`, `check_tunnel_status`).
 */
export async function resolveContainerHost(
  ctx: AppContext,
  row: VmRow,
  vmid: number,
): Promise<string> {
  if (row.ip) return row.ip;
  const ifaces = await ctx.pve.lxc.getInterfaces(vmid).catch(() => []);
  const ip = ifaces.find((i) => i.name === "eth0" && i.inet)?.inet?.split("/")[0];
  if (!ip) throw new ToolError(`No IP known for CT ${vmid} (DB has none, Proxmox reports none).`);
  return ip;
}

/**
 * Run a command on an owned container over SSH as root. Wraps the single
 * `execCommand` SSH primitive with the ownership gate and host resolution so
 * services don't re-roll either. Never throws on a non-zero exit — inspect
 * `.code` — only on connection failure.
 */
export async function runOnContainer(
  ctx: AppContext,
  vmid: number,
  cmd: string,
  opts: Partial<Omit<ExecOptions, "host" | "cmd" | "user" | "privateKey">> = {},
): Promise<ExecResult> {
  const row = requireOwnedVm(ctx, vmid);
  const host = await resolveContainerHost(ctx, row, vmid);
  return execCommand({
    host,
    cmd,
    timeoutMs: opts.timeoutMs ?? 120_000,
    user: ctx.cfg.ssh.user,
    privateKey: ctx.cfg.ssh.privateKey,
    ...opts,
  });
}
