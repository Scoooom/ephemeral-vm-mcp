import type { AppContext } from "../context.js";
import { allocateIp, buildNet0 } from "../net/ipalloc.js";
import { rootfsSizeGb } from "../proxmox/lxc.js";
import { execProxmoxTask } from "../proxmox/tasks.js";
import { execCommand } from "../ssh/exec.js";
import { sanitizeHostname, ToolError } from "./ownership.js";

/**
 * Clone the template into a new ephemeral LXC container and bring it up.
 * Shared by the `clone_vm` MCP tool and the web dashboard's create endpoint
 * so there is exactly one place that does this multi-step provisioning.
 */

/**
 * Proxmox can't shrink an LXC root disk, and the template's rootfs is 25G —
 * so 25 is the practical floor for `disk_gb`. Requests below it are
 * rejected at the input boundary (schema / API / UI) rather than silently
 * rounded up, so the caller isn't surprised by a bigger disk than they asked
 * for.
 */
export const MIN_DISK_GB = 25;

export interface CreateVmInput {
  name: string;
  task_description: string;
  template_id?: number;
  clone_type?: "linked" | "full";
  cores?: number;
  memory_mb?: number;
  /** Absolute root disk size in GiB. Omit to leave the template's default size. */
  disk_gb?: number;
  tags?: string;
}

export interface CreateVmResult {
  vmid: number;
  ip: string;
  name: string;
  status: "running";
  clone_type: "linked" | "full";
}

export async function createVm(ctx: AppContext, args: CreateVmInput): Promise<CreateVmResult> {
  const templateId = args.template_id ?? ctx.cfg.proxmox.templateId;
  const cloneType = args.clone_type ?? "linked";
  const cores = args.cores ?? 1;
  const memoryMb = args.memory_mb ?? 512;
  const diskGb = args.disk_gb;
  if (diskGb !== undefined && diskGb < MIN_DISK_GB) {
    throw new ToolError(`disk_gb must be at least ${MIN_DISK_GB} (the template's root disk can't be shrunk).`);
  }
  const hostname = sanitizeHostname(args.name);

  // 1. verify the template
  const tplConfig = await ctx.pve.lxc.getConfig(templateId);
  if (cloneType === "linked" && tplConfig.template !== 1) {
    throw new ToolError(
      `CT ${templateId} is not a Proxmox template — a linked clone needs one. ` +
        `Use clone_type='full' or run 'pct template ${templateId}' on the node.`,
    );
  }

  // 2. next free VMID in the configured range (and make sure the target pool exists)
  await ctx.pve.discovery.ensurePool(ctx.cfg.proxmox.pool);
  const newid = await nextVmidInRange(ctx);

  // 3. allocate IP + claim it with the DB row, atomically
  const tagList = ["ephemeral-mcp", ...(args.tags ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : [])];
  const { row, ip } = ctx.repo.transaction(() => {
    const alloc = allocateIp(ctx.repo, ctx.cfg.network);
    const inserted = ctx.repo.insertProvisioning({
      vmid: newid,
      name: args.name,
      template_id: templateId,
      clone_type: cloneType,
      cores,
      memory_mb: memoryMb,
      disk_gb: diskGb ?? null,
      node: ctx.pve.node,
      bridge: ctx.cfg.network.bridge,
      ip: alloc.ip,
      task_description: args.task_description,
      tags: tagList.join(","),
    });
    return { row: inserted, ip: alloc.ip };
  });

  try {
    // 4. clone
    const description = `ephemeral-mcp: ${args.task_description}`;
    const cloneUpid = await ctx.pve.lxc.clone(templateId, {
      newid,
      hostname,
      full: cloneType === "full",
      pool: ctx.cfg.proxmox.pool || undefined,
      storage: cloneType === "full" ? ctx.cfg.proxmox.storage : undefined,
      description,
    });
    const cloneTask = await execProxmoxTask(ctx.pve.client, cloneUpid, {
      timeoutMs: cloneType === "full" ? 900_000 : 300_000,
    });
    ctx.repo.addLog(row.id, "clone", cloneTask.log.join("\n"));

    // 5. configure: static IP, resources, tags
    await ctx.pve.lxc.configure(newid, {
      cores,
      memory: memoryMb,
      swap: 512,
      hostname,
      net0: buildNet0(ip, ctx.cfg.network),
      tags: tagList.join(";"),
      onboot: false,
      description,
    });

    // 5b. grow the root disk, if a bigger size was requested. Must happen
    // before start — resize only supports growing, and doing it while
    // stopped avoids any online-resize quirks on the underlying storage.
    // Proxmox rejects (or no-ops, backend-dependent) a resize to the disk's
    // current size or smaller, so check first rather than let that surface
    // as a failure — a request equal to (or below) the template's default
    // is a legitimate way to say "leave it as-is", not an error.
    if (diskGb !== undefined) {
      const newConfig = await ctx.pve.lxc.getConfig(newid);
      const currentGb = rootfsSizeGb(newConfig.rootfs);
      if (currentGb === null) {
        ctx.repo.addLog(row.id, "clone", `Could not parse current disk size from rootfs='${newConfig.rootfs}' — skipping resize.`);
      } else if (diskGb > currentGb) {
        const resizeUpid = await ctx.pve.lxc.resize(newid, "rootfs", `${diskGb}G`);
        await execProxmoxTask(ctx.pve.client, resizeUpid, { timeoutMs: 120_000 });
      } else if (diskGb < currentGb) {
        ctx.repo.addLog(
          row.id,
          "clone",
          `Requested disk_gb=${diskGb} is smaller than the template's ${currentGb}G — Proxmox can't shrink, leaving it at ${currentGb}G.`,
        );
      }
      // diskGb === currentGb: already the requested size, nothing to do.
    }

    // 6. start
    const startUpid = await ctx.pve.lxc.start(newid);
    await execProxmoxTask(ctx.pve.client, startUpid, { timeoutMs: 120_000 });

    // 7. wait for SSH
    const probe = await execCommand({
      host: ip,
      cmd: "true",
      timeoutMs: 15_000,
      user: ctx.cfg.ssh.user,
      privateKey: ctx.cfg.ssh.privateKey,
      connectRetries: 20,
      connectRetryDelayMs: 3_000,
    });
    if (probe.code !== 0) {
      throw new ToolError(`Container started but SSH probe exited ${probe.code}: ${probe.stderr.trim()}`);
    }

    ctx.repo.setStatus(row.id, "running");
    return { vmid: newid, ip, name: args.name, status: "running", clone_type: cloneType };
  } catch (err) {
    ctx.repo.setStatus(row.id, "error");
    ctx.repo.addLog(row.id, "clone", `create_vm failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    throw new ToolError(
      `create_vm failed after creating DB row (vmid ${newid}, ip ${ip}). ` +
        `The container may exist in a half-built state — inspect it, then destroy_vm(${newid}) to clean up. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Lowest free VMID in `ctx.cfg.proxmox.vmidRangeStart..vmidRangeEnd`.
 * `ctx.pve.lxc.list()` and the local DB are checked first (cheap, no extra
 * round trip); `idFree` is only called for candidates neither already knows
 * about, and is authoritative cluster-wide (catches other nodes and QEMU
 * VMs, which the other two checks can't see).
 */
async function nextVmidInRange(ctx: AppContext): Promise<number> {
  const { vmidRangeStart, vmidRangeEnd } = ctx.cfg.proxmox;
  const liveVmids = new Set((await ctx.pve.lxc.list()).map((c) => c.vmid));
  for (let id = vmidRangeStart; id <= vmidRangeEnd; id++) {
    if (liveVmids.has(id) || ctx.repo.vmidInUse(id)) continue;
    if (await ctx.pve.discovery.idFree(id)) return id;
  }
  throw new ToolError(
    `No free VMID in the configured range ${vmidRangeStart}-${vmidRangeEnd}. ` +
      `Untrack or destroy some containers, or widen EPHEMERAL_VMID_RANGE_START/END.`,
  );
}
