import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { deployApp } from "../services/deploy.js";
import { checkTunnelStatus } from "../services/tunnel.js";
import { handler, jsonResult } from "./util.js";

export function registerDeployTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "deploy_app",
    {
      title: "Deploy an app onto a container",
      description:
        "On an existing, running container this server owns: clone/pull a git repo into /opt/apps/<name>, " +
        "install dependencies (npm/pip, auto-detected), and run it under a systemd unit (app-<name>). " +
        "GitHub repos are cloned with the container's pre-authorized `gh`. Every step is logged to vm_logs " +
        "under phase 'deploy'. Returns { deployed, service_name, app_dir, code, stdout, stderr }.",
      inputSchema: {
        vmid: z.number().int().describe("Container VMID (must be an active, owned container)."),
        repo_url: z.string().min(1).describe("Git repo URL (https or ssh). github.com URLs use `gh repo clone`."),
        branch: z.string().optional().describe("Branch to deploy (default 'main')."),
        start_command: z
          .string()
          .min(1)
          .describe("Command to start the app, run from the repo root (e.g. 'node server.js')."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; repo_url: string; branch?: string; start_command: string }>(
      "deploy_app",
      async ({ vmid, repo_url, branch, start_command }) => {
        const result = await deployApp(ctx, { vmid, repoUrl: repo_url, branch, startCommand: start_command });
        return jsonResult(result);
      },
      ctx,
    ),
  );

  server.registerTool(
    "check_tunnel_status",
    {
      title: "Check a container's Cloudflare tunnel",
      description:
        "Health-check the Cloudflare tunnel for a deployed container (does not create one). Resolves the " +
        "public hostname from the argument, the recorded deployment, or the container's cloudflared config; " +
        "confirms cloudflared is running; and probes the hostname over HTTPS. A 5xx response is unhealthy. " +
        "Set retries to poll until healthy. Result is recorded on the deployment row.",
      inputSchema: {
        vmid: z.number().int().describe("Container VMID (must be an active, owned container)."),
        hostname: z.string().optional().describe("Public tunnel hostname to check. Omit to auto-resolve."),
        path: z.string().optional().describe("Request path to probe (default '/')."),
        retries: z.number().int().min(0).max(30).optional().describe("Extra probe attempts if not yet healthy (default 0)."),
        interval_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe("Seconds between retry probes (default 10)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; hostname?: string; path?: string; retries?: number; interval_seconds?: number }>(
      "check_tunnel_status",
      async ({ vmid, hostname, path, retries, interval_seconds }) => {
        const result = await checkTunnelStatus(ctx, vmid, {
          hostname,
          path,
          retries,
          intervalSeconds: interval_seconds,
        });
        return jsonResult(result);
      },
      ctx,
    ),
  );
}
