import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { ipFromNetConfig } from "../proxmox/lxc.js";
import { handler, jsonResult, requireOwnedVm } from "./util.js";

export function registerInventoryTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_active_vms",
    {
      title: "List active ephemeral VMs",
      description: "Containers this server currently manages (status != destroyed), from the local DB.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler("list_active_vms", async () => jsonResult(ctx.repo.listActive()), ctx),
  );

  server.registerTool(
    "list_vm_history",
    {
      title: "List all VM records",
      description: "Every container record this server has ever created, including destroyed ones.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler("list_vm_history", async () => jsonResult(ctx.repo.listAll()), ctx),
  );

  server.registerTool(
    "get_vm_status",
    {
      title: "Get VM status",
      description: "Live Proxmox status for a container plus its local DB record, with any drift flagged.",
      inputSchema: { vmid: z.number().int().describe("Container VMID.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler<{ vmid: number }>(
      "get_vm_status",
      async ({ vmid }) => {
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
        return jsonResult({ db: row, proxmox: live, drift });
      },
      ctx,
    ),
  );

  server.registerTool(
    "get_vm_ip",
    {
      title: "Get VM IP",
      description:
        "Resolve a container's IPv4 from Proxmox (reads the container netns directly — no guest agent). " +
        "The IP is assigned at clone time and stored in the DB; this is a verification/fallback path.",
      inputSchema: { vmid: z.number().int().describe("Container VMID.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler<{ vmid: number }>(
      "get_vm_ip",
      async ({ vmid }) => {
        const row = requireOwnedVm(ctx, vmid);
        let live: string | null = null;
        try {
          const ifaces = await ctx.pve.lxc.getInterfaces(vmid);
          const eth0 = ifaces.find((i) => i.name === "eth0") ?? ifaces.find((i) => i.inet);
          live = eth0?.inet?.split("/")[0] ?? null;
        } catch {
          /* container may be stopped */
        }
        if (!live) {
          const cfg = await ctx.pve.lxc.getConfig(vmid).catch(() => null);
          live = cfg ? ipFromNetConfig(cfg.net0) : null;
        }
        return jsonResult({ db_ip: row.ip, resolved_ip: live, match: live === row.ip });
      },
      ctx,
    ),
  );
}
