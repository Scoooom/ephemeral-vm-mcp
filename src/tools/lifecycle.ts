import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { OWNER } from "../db/repo.js";
import { createVm, MIN_DISK_GB } from "../services/create.js";
import { destroyVm, rebootVm, startVm, stopVm } from "../services/lifecycle.js";
import { handler, jsonResult, textResult } from "./util.js";

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
        disk_gb: z
          .number()
          .int()
          .min(MIN_DISK_GB)
          .max(2_048)
          .optional()
          .describe(
            `Absolute root disk size in GiB, minimum ${MIN_DISK_GB} (the template's disk, grow-only). Omit to leave it at ${MIN_DISK_GB}G.`,
          ),
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
      disk_gb?: number;
      tags?: string;
    }>(
      "clone_vm",
      async (args) => jsonResult(await createVm(ctx, args)),
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
