import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { execProxmoxTask } from "../proxmox/tasks.js";
import { handler, jsonResult, requireOwnedVm, textResult } from "./util.js";

const SNAP_NAME = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/, "letters/digits/-/_ , starting with a letter, <=40 chars")
  .describe("Snapshot name.");

export function registerSnapshotTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "create_snapshot",
    {
      title: "Create snapshot",
      description:
        "Snapshot a container (filesystem only — LXC snapshots don't capture RAM). " +
        "Typical use: snapshot after run_post_create_script, before run_claude_task.",
      inputSchema: { vmid: z.number().int().describe("Container VMID."), snapshot_name: SNAP_NAME },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler<{ vmid: number; snapshot_name: string }>(
      "create_snapshot",
      async ({ vmid, snapshot_name }) => {
        const row = requireOwnedVm(ctx, vmid);
        const upid = await ctx.pve.lxc.createSnapshot(vmid, snapshot_name, "ephemeral-mcp");
        await execProxmoxTask(ctx.pve.client, upid, { timeoutMs: 300_000 });
        ctx.repo.addSnapshot(row.id, snapshot_name);
        return textResult(`Snapshot '${snapshot_name}' created on CT ${vmid}.`);
      },
      ctx,
    ),
  );

  server.registerTool(
    "rollback_snapshot",
    {
      title: "Roll back to snapshot",
      description:
        "Restore a container to a snapshot. Proxmox stops the container to do this; " +
        "if it was running, it is started again afterwards.",
      inputSchema: { vmid: z.number().int().describe("Container VMID."), snapshot_name: SNAP_NAME },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler<{ vmid: number; snapshot_name: string }>(
      "rollback_snapshot",
      async ({ vmid, snapshot_name }) => {
        const row = requireOwnedVm(ctx, vmid);
        const wasRunning = (await ctx.pve.lxc.getStatus(vmid)).status === "running";
        const upid = await ctx.pve.lxc.rollbackSnapshot(vmid, snapshot_name);
        await execProxmoxTask(ctx.pve.client, upid, { timeoutMs: 300_000 });

        let note = "";
        if (wasRunning) {
          const startUpid = await ctx.pve.lxc.start(vmid);
          await execProxmoxTask(ctx.pve.client, startUpid, { timeoutMs: 120_000 });
          ctx.repo.setStatus(row.id, "running");
          note = " Container restarted.";
        } else {
          ctx.repo.setStatus(row.id, "stopped");
        }
        return textResult(`Rolled CT ${vmid} back to '${snapshot_name}'.${note}`);
      },
      ctx,
    ),
  );

  server.registerTool(
    "list_snapshots",
    {
      title: "List snapshots",
      description: "Snapshots for a container, from Proxmox merged with the local record.",
      inputSchema: { vmid: z.number().int().describe("Container VMID.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler<{ vmid: number }>(
      "list_snapshots",
      async ({ vmid }) => {
        const row = requireOwnedVm(ctx, vmid);
        const live = await ctx.pve.lxc.listSnapshots(vmid);
        const tracked = new Set(ctx.repo.listSnapshots(row.id).map((s) => s.snapshot_name));
        return jsonResult(
          live
            .filter((s) => s.name !== "current")
            .map((s) => ({ name: s.name, description: s.description, snaptime: s.snaptime, tracked: tracked.has(s.name) })),
        );
      },
      ctx,
    ),
  );
}
