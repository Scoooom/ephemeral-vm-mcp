import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { VmRow } from "../db/repo.js";
import { execCommand, shellQuote, type ExecResult } from "../ssh/exec.js";
import { clip, handler, jsonResult, requireOwnedVm, textResult, ToolError } from "./util.js";

/** Resolve the container's IP: DB first, Proxmox netns as fallback. */
async function resolveHost(ctx: AppContext, row: VmRow, vmid: number): Promise<string> {
  if (row.ip) return row.ip;
  const ifaces = await ctx.pve.lxc.getInterfaces(vmid).catch(() => []);
  const ip = ifaces.find((i) => i.name === "eth0" && i.inet)?.inet?.split("/")[0];
  if (!ip) throw new ToolError(`No IP known for CT ${vmid} (DB has none, Proxmox reports none).`);
  return ip;
}

function summarize(r: ExecResult): { code: number | null; timedOut: boolean; stdout: string; stderr: string } {
  return { code: r.code, timedOut: r.timedOut, stdout: clip(r.stdout), stderr: clip(r.stderr) };
}

export function registerExecTools(server: McpServer, ctx: AppContext): void {
  const ssh = ctx.cfg.ssh;

  server.registerTool(
    "exec_command",
    {
      title: "Run a command on a container",
      description:
        "Run a shell command on a container over SSH (as root) and return its exit code, stdout and stderr. " +
        "The shared primitive the other exec tools build on. Full output is logged to vm_logs.",
      inputSchema: {
        vmid: z.number().int().describe("Container VMID."),
        cmd: z.string().min(1).describe("Command line, run with the container's default shell."),
        timeout: z.number().int().min(1).max(3_600).optional().describe("Timeout in seconds (default 120)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; cmd: string; timeout?: number }>(
      "exec_command",
      async ({ vmid, cmd, timeout }) => {
        const row = requireOwnedVm(ctx, vmid);
        const host = await resolveHost(ctx, row, vmid);
        const result = await execCommand({
          host,
          cmd,
          timeoutMs: (timeout ?? 120) * 1_000,
          user: ssh.user,
          privateKey: ssh.privateKey,
        });
        ctx.repo.addLog(
          row.id,
          "exec",
          `$ ${cmd}\n[exit ${result.code}${result.timedOut ? " TIMED OUT" : ""}]\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
        return jsonResult(summarize(result));
      },
      ctx,
    ),
  );

  server.registerTool(
    "run_post_create_script",
    {
      title: "Run the one-shot post-create script",
      description:
        "Run a saved post-create script on a container. Strictly one-shot per container unless force=true. " +
        "The script is transferred safely (base64) and run with bash as root.",
      inputSchema: {
        vmid: z.number().int().describe("Container VMID."),
        script_name: z.string().min(1).describe("Name of a script saved via set_post_create_script."),
        force: z.boolean().optional().describe("Re-run even if it already ran on this container."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; script_name: string; force?: boolean }>(
      "run_post_create_script",
      async ({ vmid, script_name, force }) => {
        const row = requireOwnedVm(ctx, vmid);
        if (row.post_create_ran && !force) {
          throw new ToolError(
            `Post-create script already ran on CT ${vmid} at ${row.post_create_ran}. Pass force=true to re-run.`,
          );
        }
        const script = ctx.repo.getScript(script_name);
        if (!script) throw new ToolError(`No post-create script named '${script_name}'. Save one with set_post_create_script.`);

        const host = await resolveHost(ctx, row, vmid);
        const b64 = Buffer.from(script.script, "utf8").toString("base64");
        const cmd = `echo ${shellQuote(b64)} | base64 -d > /tmp/post-create.sh && chmod +x /tmp/post-create.sh && bash /tmp/post-create.sh`;

        ctx.repo.setStatus(row.id, "task_running");
        try {
          const result = await execCommand({
            host,
            cmd,
            timeoutMs: 600_000,
            user: ssh.user,
            privateKey: ssh.privateKey,
          });
          ctx.repo.addLog(
            row.id,
            "post_create",
            `script '${script_name}' [exit ${result.code}${result.timedOut ? " TIMED OUT" : ""}]\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          );
          if (result.code === 0 && !result.timedOut) ctx.repo.markPostCreateRan(row.id);
          return jsonResult({ script: script_name, ...summarize(result) });
        } finally {
          ctx.repo.setStatus(row.id, "running");
        }
      },
      ctx,
    ),
  );

  server.registerTool(
    "run_claude_task",
    {
      title: "Run a headless Claude Code task",
      description:
        "Run `claude -p` non-interactively on a container and return its output. Bounded by --max-turns " +
        `(default ${ctx.cfg.claudeDefaultMaxTurns}) and a wall-clock timeout.`,
      inputSchema: {
        vmid: z.number().int().describe("Container VMID."),
        prompt: z.string().min(1).describe("The task prompt for Claude Code."),
        max_turns: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Agent turn budget (default ${ctx.cfg.claudeDefaultMaxTurns}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; prompt: string; max_turns?: number }>(
      "run_claude_task",
      async ({ vmid, prompt, max_turns }) => {
        const row = requireOwnedVm(ctx, vmid);
        const host = await resolveHost(ctx, row, vmid);
        const turns = max_turns ?? ctx.cfg.claudeDefaultMaxTurns;
        const cmd = `claude -p ${shellQuote(prompt)} --permission-mode bypassPermissions --max-turns ${turns} --output-format json`;

        ctx.repo.setStatus(row.id, "task_running");
        try {
          const result = await execCommand({
            host,
            cmd,
            timeoutMs: 900_000,
            user: ssh.user,
            privateKey: ssh.privateKey,
          });
          ctx.repo.addLog(
            row.id,
            "claude_task",
            `prompt: ${prompt}\nturns: ${turns}\n[exit ${result.code}${result.timedOut ? " TIMED OUT" : ""}]\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          );
          return jsonResult({ turns, ...summarize(result) });
        } finally {
          ctx.repo.setStatus(row.id, "running");
        }
      },
      ctx,
    ),
  );
}
