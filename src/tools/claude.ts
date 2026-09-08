import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { getClaudeTaskStatus, launchClaudeTask } from "../services/claudeTask.js";
import { handler, jsonResult } from "./util.js";

export function registerClaudeTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "run_claude_task",
    {
      title: "Launch a live-monitorable Claude Code task",
      description:
        "Start Claude Code on an owned container as a persistent interactive session with Remote Control " +
        "enabled, inside a detached tmux session (so it survives the SSH connection ending). Returns " +
        "immediately with the Remote Control session_url — open it from a phone or claude.ai/code to watch " +
        "or steer the run live. The task runs on detached; poll get_claude_task_status(vmid) for completion " +
        "(it watches for a sentinel file the task writes when done) and check_tunnel_status(vmid) before " +
        `declaring a deploy done. Auto-killed after ${ctx.cfg.claudeTaskTimeoutSeconds}s if it never completes ` +
        "(--max-turns does not apply to Remote Control sessions).",
      inputSchema: {
        vmid: z.number().int().describe("Container VMID (must be an active, owned container)."),
        prompt: z.string().min(1).describe("The task prompt for Claude Code."),
        timeout_seconds: z
          .number()
          .int()
          .min(60)
          .max(24 * 3_600)
          .optional()
          .describe(
            `Wall-clock safety valve; the tmux session is killed and the task marked timed_out after this ` +
              `(default ${ctx.cfg.claudeTaskTimeoutSeconds}).`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; prompt: string; timeout_seconds?: number }>(
      "run_claude_task",
      async ({ vmid, prompt, timeout_seconds }) => {
        const result = await launchClaudeTask(ctx, { vmid, prompt, timeoutSeconds: timeout_seconds });
        return jsonResult(result);
      },
      ctx,
    ),
  );

  server.registerTool(
    "get_claude_task_status",
    {
      title: "Check a launched Claude Code task",
      description:
        "Report the state of the most recent run_claude_task on a container: running | completed | failed | " +
        "timed_out. Completion is detected by a JSON sentinel file the task writes as its last action " +
        "(carrying repo_url / tunnel_hostname / summary); a vanished tmux session or an elapsed timeout also " +
        "finalize the task. While running, includes a tail of the live tmux pane. Poll this until it is no " +
        "longer 'running' before treating a run_claude_task as done.",
      inputSchema: {
        vmid: z.number().int().describe("Container VMID (must be an active, owned container)."),
        tail_lines: z
          .number()
          .int()
          .min(0)
          .max(400)
          .optional()
          .describe("Lines of live tmux pane output to include while running (default 40, 0 to skip)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    handler<{ vmid: number; tail_lines?: number }>(
      "get_claude_task_status",
      async ({ vmid, tail_lines }) => {
        const result = await getClaudeTaskStatus(ctx, vmid, { tailLines: tail_lines });
        return jsonResult(result);
      },
      ctx,
    ),
  );
}
