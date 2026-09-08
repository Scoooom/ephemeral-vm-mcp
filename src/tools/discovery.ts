import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { handler, jsonResult } from "./util.js";

export function registerDiscoveryTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_templates",
    {
      title: "List clone templates",
      description: "LXC templates on Proxmox that clone_vm can clone from.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(
      "list_templates",
      async () => jsonResult(await ctx.pve.discovery.templates()),
      ctx,
    ),
  );

  server.registerTool(
    "list_nodes",
    {
      title: "List Proxmox nodes",
      description: "Proxmox nodes and their online status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler("list_nodes", async () => jsonResult(await ctx.pve.discovery.nodes()), ctx),
  );

  server.registerTool(
    "list_storage",
    {
      title: "List node storage",
      description:
        "Storage targets on a node (id, type, content, free/total space). " +
        "Ephemeral containers are always placed on the configured non-SSD pool.",
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe(`Proxmox node name; defaults to '${ctx.cfg.proxmox.node}'.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler<{ node?: string }>(
      "list_storage",
      async ({ node }) => jsonResult(await ctx.pve.discovery.storage(node)),
      ctx,
    ),
  );
}
