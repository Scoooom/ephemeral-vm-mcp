import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { OWNER } from "../db/repo.js";
import { allocateIp, buildNet0 } from "../net/ipalloc.js";
import { execProxmoxTask } from "../proxmox/tasks.js";
import { execCommand } from "../ssh/exec.js";
import { destroyVm, rebootVm, startVm, stopVm } from "../services/lifecycle.js";
import { handler, jsonResult, sanitizeHostname, textResult, ToolError } from "./util.js";

export function registerLifecycleTools(server: McpServer, ctx: AppContext): void {
  registerCloneVm(server, ctx);
  registerPowerTool(server, ctx, "start_vm", "Start a stopped container.", startVm);
  registerPowerTool(
    server,
    ctx,
    "stop_vm",
    "Gracefully shut down a container (falls back to hard stop).",
    stopVm,
    true,
  );
  registerPowerTool(server, ctx, "reboot_vm", "Reboot a container (e.g. to pick up a config change).", rebootVm);
  registerDestroyVm(server, ctx);
}

function registerCloneVm(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "clone_vm",
    {
      title: "Clone an ephemeral container",
      description:
        "Clone the template into a new ephemeral LXC container: allocates the next free VMID and " +
        "static IP on 10.10.30.0/24 automatically (do NOT pass them), places it on the non-SSD pool, " +
        "starts it, and waits until SSH is reachable. Returns { vmid, ip, name, status }.",
      inputSchema: {
        name: z.string().min(1).describe("Human name for the container; also the basis of its hostname."),
        task_description: z.string().min(1).describe("Why this container exists (mirrored into the Proxmox description)."),
        template_id: z
          .number()
          .int()
          .optional()
          .describe(`Template VMID to clone. Defaults to ${ctx.cfg.proxmox.templateId}.`),
        clone_type: z.enum(["linked", "full"]).optional().describe("'linked' (default, fast) or 'full'."),
        cores: z.number().int().min(1).max(32).optional().describe("vCPU count (default 1)."),
        memory_mb: z.number().int().min(128).max(65_536).optional().describe("RAM in MiB (default 512)."),
        tags: z.string().optional().describe("Comma-separated extra Proxmox tags, e.g. 'calendar-app'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{
      name: string;
      task_description: string;
      template_id?: number;
      clone_type?: "linked" | "full";
      cores?: number;
      memory_mb?: number;
      tags?: string;
    }>(
      "clone_vm",
      async (args) => {
        const templateId = args.template_id ?? ctx.cfg.proxmox.templateId;
        const cloneType = args.clone_type ?? "linked";
        const cores = args.cores ?? 1;
        const memoryMb = args.memory_mb ?? 512;
        const hostname = sanitizeHostname(args.name);

        // 1. verify the template
        const tplConfig = await ctx.pve.lxc.getConfig(templateId);
        if (cloneType === "linked" && tplConfig.template !== 1) {
          throw new ToolError(
            `CT ${templateId} is not a Proxmox template — a linked clone needs one. ` +
              `Use clone_type='full' or run 'pct template ${templateId}' on the node.`,
          );
        }

        // 2. next free VMID (and make sure the target pool exists)
        await ctx.pve.discovery.ensurePool(ctx.cfg.proxmox.pool);
        let newid = await ctx.pve.discovery.nextId();
        const liveVmids = new Set((await ctx.pve.lxc.list()).map((c) => c.vmid));
        while (liveVmids.has(newid) || ctx.repo.vmidInUse(newid)) newid++;

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
          return jsonResult({ vmid: newid, ip, name: args.name, status: "running", clone_type: cloneType });
        } catch (err) {
          ctx.repo.setStatus(row.id, "error");
          ctx.repo.addLog(row.id, "clone", `clone_vm failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
          throw new ToolError(
            `clone_vm failed after creating DB row (vmid ${newid}, ip ${ip}). ` +
              `The container may exist in a half-built state — inspect it, then destroy_vm(${newid}) to clean up. ` +
              `Cause: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      ctx,
    ),
  );
}

function registerPowerTool(
  server: McpServer,
  ctx: AppContext,
  name: "start_vm" | "stop_vm" | "reboot_vm",
  description: string,
  action: (ctx: AppContext, vmid: number) => Promise<"running" | "stopped">,
  destructive = false,
): void {
  server.registerTool(
    name,
    {
      title: name.replace("_", " "),
      description,
      inputSchema: { vmid: z.number().int().describe("Container VMID.") },
      annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: true },
    },
    handler<{ vmid: number }>(
      name,
      async ({ vmid }) => {
        const status = await action(ctx, vmid);
        return textResult(`CT ${vmid} is now ${status}.`);
      },
      ctx,
    ),
  );
}

function registerDestroyVm(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "destroy_vm",
    {
      title: "Destroy an ephemeral container",
      description:
        "Stop and permanently delete a container this server created. Refuses any VMID that is not " +
        `an active ${OWNER}-managed row in the local DB — it cannot be pointed at other containers.`,
      inputSchema: { vmid: z.number().int().describe("Container VMID.") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler<{ vmid: number }>(
      "destroy_vm",
      async ({ vmid }) => {
        const { ip } = await destroyVm(ctx, vmid);
        return textResult(`CT ${vmid} destroyed. IP ${ip ?? "?"} is now free for reuse.`);
      },
      ctx,
    ),
  );
}
