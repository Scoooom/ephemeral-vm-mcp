import type { AppContext } from "../context.js";
import type { ClaudeTaskRow } from "../db/repo.js";
import { logger } from "../logger.js";
import { requireOwnedVm, ToolError } from "./ownership.js";
import { runOnContainer } from "./remote.js";
import { checkTunnelStatus } from "./tunnel.js";

/**
 * run_claude_task, reworked for live monitoring via Claude Code's Remote Control.
 *
 * The old implementation ran `claude -p '<prompt>' --max-turns N` synchronously
 * over one SSH exec and returned the final JSON result. Remote Control cannot be
 * combined with `-p` — it needs a genuine interactive session — so this version:
 *
 *   1. Launches `claude --remote-control '<prompt>' --permission-mode
 *      bypassPermissions` inside a DETACHED tmux session on the container, so it
 *      survives the SSH connection closing.
 *   2. Scrapes the RC session URL out of the tmux pane and stores it
 *      (`vms.session_url` + the `claude_tasks` row) so the dashboard can offer a
 *      "join live session" link.
 *   3. Returns immediately — the task keeps running in tmux.
 *
 * COMPLETION DETECTION.  `-p` exited cleanly and printed a final result; an RC
 * session never exits on its own. So the wrapped prompt instructs Claude Code to
 * write a one-line JSON sentinel file as its very last action, and
 * getClaudeTaskStatus() / the background reaper poll for it:
 *
 *   {"status":"success"|"failure","repo_url":...,"tunnel_hostname":...,"summary":...}
 *
 * A task that never writes the sentinel is caught two other ways: the tmux
 * session disappearing (→ "failed"), or `claudeTaskTimeoutSeconds` elapsing
 * (→ "timed_out", tmux session killed). The timeout is the safety valve that
 * `--max-turns` used to be — that flag is headless-only and does not apply to an
 * interactive RC session, so we do not pass it.
 */

const SENTINEL_KEYS = "status, repo_url, tunnel_hostname, summary";

export interface LaunchClaudeTaskInput {
  vmid: number;
  prompt: string;
  timeoutSeconds?: number;
}

export interface ClaudeTaskLaunchResult {
  vmid: number;
  task_id: number;
  tmux_session: string;
  session_url: string | null;
  sentinel_path: string;
  status: "running";
  started_at: string;
  expires_at: string;
  note: string;
}

export interface ClaudeTaskStatusResult {
  vmid: number;
  task_id: number;
  status: ClaudeTaskRow["status"];
  session_url: string | null;
  tmux_session: string;
  sentinel_path: string;
  repo_url: string | null;
  result_summary: string | null;
  started_at: string;
  expires_at: string | null;
  completed_at: string | null;
  detail: string;
  pane_tail?: string;
}

function tmuxSessionName(vmid: number): string {
  return `claude-task-${vmid}`;
}

function workdirFor(vmid: number): string {
  return `/root/claude-task-${vmid}`;
}

function sentinelPathFor(vmid: number): string {
  return `${workdirFor(vmid)}/.done`;
}

/** SQLite `CURRENT_TIMESTAMP` strings are UTC without a zone marker. */
function parseSqliteUtc(ts: string): number {
  return Date.parse(ts.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? "" : "Z"));
}

function completionProtocol(sentinelPath: string, workdir: string): string {
  return [
    ``,
    `────────────────────────────────────────────────────────`,
    `TASK HARNESS PROTOCOL (appended automatically — follow it exactly):`,
    `- You are running head-less in a detached session under ${workdir}. Nobody`,
    `  is watching unless they join via Remote Control. Work autonomously all the`,
    `  way to completion; do not stop to ask questions.`,
    `- \`gh\` is already authenticated on this machine. If the task needs its own`,
    `  GitHub repo, create it yourself, e.g.`,
    `      gh repo create <name> --private --source=. --push`,
    `- When the ENTIRE task is finished — whether it succeeded or failed — your`,
    `  FINAL action must be to write a single-line JSON object to`,
    `      ${sentinelPath}`,
    `  with these keys: ${SENTINEL_KEYS}. For example:`,
    `      printf '%s\\n' '{"status":"success","repo_url":"https://github.com/OWNER/NAME","tunnel_hostname":"app.example.com","summary":"Built and deployed; tunnel healthy"}' > ${sentinelPath}`,
    `  Use "status":"failure" (and explain in "summary") if you could not finish.`,
    `  Set repo_url / tunnel_hostname to null if not applicable.`,
    `- Write that file exactly ONCE, and only when everything else is done. The`,
    `  harness polls for it to learn the task is complete.`,
    `────────────────────────────────────────────────────────`,
  ].join("\n");
}

/** Launch the RC session in a detached tmux session and capture its URL. */
export async function launchClaudeTask(
  ctx: AppContext,
  input: LaunchClaudeTaskInput,
): Promise<ClaudeTaskLaunchResult> {
  const row = requireOwnedVm(ctx, input.vmid);
  const vmid = input.vmid;
  const session = tmuxSessionName(vmid);
  const workdir = workdirFor(vmid);
  const sentinelPath = sentinelPathFor(vmid);
  const promptFile = `${workdir}/prompt.txt`;

  const timeoutSeconds = Math.max(
    60,
    Math.min(input.timeoutSeconds ?? ctx.cfg.claudeTaskTimeoutSeconds, 24 * 3_600),
  );
  const expiresAt = new Date(Date.now() + timeoutSeconds * 1_000).toISOString();

  const fullPrompt = `${input.prompt}\n${completionProtocol(sentinelPath, workdir)}`;
  const promptB64 = Buffer.from(fullPrompt, "utf8").toString("base64");

  const task = ctx.repo.insertClaudeTask({
    vmId: row.id,
    prompt: input.prompt,
    tmuxSession: session,
    sentinelPath,
    expiresAt,
  });

  // The inner command is handed verbatim to tmux, which runs it with `sh -c`.
  // Single-quoted here so the outer shell leaves `$(cat ...)` for tmux's shell.
  // IS_SANDBOX=1: Claude Code refuses bypassPermissions as root without it.
  const inner = `cd ${workdir} && exec env IS_SANDBOX=1 claude --remote-control "$(cat ${promptFile})" --permission-mode bypassPermissions`;

  const script = [
    `set -u`,
    `command -v tmux >/dev/null 2>&1 || { echo "NO_TMUX"; exit 3; }`,
    `command -v claude >/dev/null 2>&1 || { echo "NO_CLAUDE"; exit 4; }`,
    `mkdir -p ${workdir}`,
    `printf '%s' "$PROMPT_B64" | base64 -d > ${promptFile}`,
    `rm -f ${sentinelPath}`,
    `tmux kill-session -t ${session} 2>/dev/null || true`,
    `tmux new-session -d -s ${session} '${inner}'`,
    `for i in $(seq 1 8); do`,
    `  sleep 3`,
    `  echo "----PANE $i----"`,
    `  tmux capture-pane -t ${session} -p -J -S -400 2>/dev/null || true`,
    `done`,
    `echo "----END----"`,
    `tmux has-session -t ${session} 2>/dev/null && echo "SESSION=alive" || echo "SESSION=dead"`,
  ].join("\n");

  ctx.repo.setStatus(row.id, "task_running");
  const result = await runOnContainer(ctx, vmid, script, {
    timeoutMs: 90_000,
    env: { PROMPT_B64: promptB64 },
  });

  if (/^NO_TMUX$/m.test(result.stdout)) {
    ctx.repo.finishClaudeTask(task.id, "failed", { summary: "tmux is not installed on the container" });
    ctx.repo.setStatus(row.id, "running");
    throw new ToolError(`CT ${vmid} has no \`tmux\` — cannot run a detached Remote Control session.`);
  }
  if (/^NO_CLAUDE$/m.test(result.stdout)) {
    ctx.repo.finishClaudeTask(task.id, "failed", { summary: "claude CLI is not installed on the container" });
    ctx.repo.setStatus(row.id, "running");
    throw new ToolError(`CT ${vmid} has no \`claude\` CLI on PATH.`);
  }

  const alive = /^SESSION=alive$/m.test(result.stdout);
  const sessionUrl = parseSessionUrl(result.stdout);
  if (sessionUrl) ctx.repo.setClaudeTaskSessionUrl(task.id, row.id, sessionUrl);

  if (!alive) {
    // Session already gone after launch — claude exited immediately (bad args,
    // auth, ...). Leave a failure record rather than a dangling "running" task.
    ctx.repo.finishClaudeTask(task.id, "failed", {
      summary: "Remote Control session exited immediately after launch — check the pane output in vm_logs",
    });
  }

  ctx.repo.addLog(
    row.id,
    "claude_task",
    `run_claude_task #${task.id} launch (tmux ${session}, timeout ${timeoutSeconds}s)\n` +
      `session_url: ${sessionUrl ?? "NOT FOUND in pane — join manually via claude.ai/code"}\n` +
      `alive after launch: ${alive}\n--- prompt ---\n${input.prompt}\n--- pane ---\n${result.stdout}`,
  );
  // Back to 'running'; the task lives in tmux now, tracked via claude_tasks.
  ctx.repo.setStatus(row.id, "running");

  logger.info(`run_claude_task #${task.id} CT ${vmid}: launched (url=${sessionUrl ?? "?"}, alive=${alive})`);

  return {
    vmid,
    task_id: task.id,
    tmux_session: session,
    session_url: sessionUrl,
    sentinel_path: sentinelPath,
    status: "running",
    started_at: task.started_at,
    expires_at: expiresAt,
    note:
      (sessionUrl
        ? `Remote Control session live at ${sessionUrl} — open it to watch or steer the run. `
        : `Could not parse the Remote Control URL from the pane; run get_claude_task_status or attach with 'tmux attach -t ${session}'. `) +
      `The task runs detached in tmux; poll get_claude_task_status(${vmid}) (it watches for the ${sentinelPath} completion sentinel) ` +
      `and check_tunnel_status(${vmid}) before declaring a deploy done. Auto-killed after ${timeoutSeconds}s if it never completes.`,
  };
}

const URL_PATTERNS: RegExp[] = [
  /https?:\/\/claude\.ai\/[^\s"'<>)\]]+/i,
  /https?:\/\/[^\s"'<>)\]]*\bclaude\.ai\/[^\s"'<>)\]]+/i,
  /https?:\/\/[^\s"'<>)\]]*claude[^\s"'<>)\]]*/i,
];

/**
 * Pull the Remote Control session URL out of captured pane text. The exact
 * rendering is Claude-Code-version-dependent, so we try progressively looser
 * matches and settle for any claude.ai-ish URL.
 */
export function parseSessionUrl(text: string): string | null {
  for (const re of URL_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].replace(/[.,;]+$/, "");
  }
  return null;
}

interface SentinelPayload {
  status: "success" | "failure";
  repoUrl: string | null;
  tunnelHostname: string | null;
  summary: string | null;
}

export function parseSentinel(text: string): SentinelPayload {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        status: String(o.status ?? "").toLowerCase() === "failure" ? "failure" : "success",
        repoUrl: typeof o.repo_url === "string" && o.repo_url ? o.repo_url : null,
        tunnelHostname:
          typeof o.tunnel_hostname === "string" && o.tunnel_hostname ? o.tunnel_hostname : null,
        summary: typeof o.summary === "string" && o.summary ? o.summary : null,
      };
    } catch {
      /* malformed JSON — fall through to the text heuristic */
    }
  }
  return {
    status: /\b(fail|failure|error|could not|unable)\b/i.test(trimmed) ? "failure" : "success",
    repoUrl: null,
    tunnelHostname: null,
    summary: trimmed.slice(0, 300) || null,
  };
}

interface Probe {
  sentinel: string | null;
  alive: boolean;
  reachable: boolean;
}

/** One SSH round-trip: read the sentinel (if any) and whether tmux is still up. */
async function probeClaudeTask(ctx: AppContext, vmid: number, task: ClaudeTaskRow): Promise<Probe> {
  const script = [
    `if [ -s '${task.sentinel_path}' ]; then echo "----SENTINEL----"; cat '${task.sentinel_path}'; echo; echo "----ENDSENTINEL----"; fi`,
    `tmux has-session -t ${task.tmux_session} 2>/dev/null && echo "SESSION=alive" || echo "SESSION=dead"`,
  ].join("\n");
  const r = await runOnContainer(ctx, vmid, script, { timeoutMs: 30_000 }).catch(() => null);
  if (!r) return { sentinel: null, alive: false, reachable: false };
  const m = r.stdout.match(/----SENTINEL----\n([\s\S]*?)\n----ENDSENTINEL----/);
  return {
    sentinel: m && m[1].trim() ? m[1] : null,
    alive: /^SESSION=alive$/m.test(r.stdout),
    reachable: true,
  };
}

async function killSession(ctx: AppContext, vmid: number, session: string): Promise<void> {
  await runOnContainer(ctx, vmid, `tmux kill-session -t ${session} 2>/dev/null || true`, {
    timeoutMs: 20_000,
  }).catch(() => {});
}

async function capturePaneTail(
  ctx: AppContext,
  vmid: number,
  session: string,
  lines: number,
): Promise<string | undefined> {
  const n = Math.max(1, Math.min(lines, 400));
  const r = await runOnContainer(
    ctx,
    vmid,
    `tmux capture-pane -t ${session} -p -J -S -${n} 2>/dev/null | tail -n ${n} || true`,
    { timeoutMs: 20_000 },
  ).catch(() => null);
  const out = r?.stdout.trim();
  return out ? out : undefined;
}

interface Resolution {
  status: ClaudeTaskRow["status"];
  completed_at: string | null;
  repo_url: string | null;
  result_summary: string | null;
  detail: string;
}

/**
 * Advance a running task's state from what the container currently reports.
 * Shared by getClaudeTaskStatus() and the reaper. Idempotent: a task that is
 * already finalized is returned unchanged.
 */
export async function resolveClaudeTask(
  ctx: AppContext,
  task: ClaudeTaskRow,
  vmid: number,
): Promise<Resolution> {
  if (task.status !== "running") {
    return {
      status: task.status,
      completed_at: task.completed_at,
      repo_url: task.repo_url,
      result_summary: task.result_summary,
      detail: "already finalized",
    };
  }

  const probe = await probeClaudeTask(ctx, vmid, task);

  const finishFromSentinel = async (raw: string): Promise<Resolution> => {
    const parsed = parseSentinel(raw);
    const status = parsed.status === "failure" ? "failed" : "completed";
    ctx.repo.finishClaudeTask(task.id, status, {
      repoUrl: parsed.repoUrl,
      summary: parsed.summary,
    });
    await killSession(ctx, vmid, task.tmux_session);
    ctx.repo.addLog(
      task.vm_id,
      "claude_task",
      `run_claude_task #${task.id} ${status} (sentinel)\n${raw.trim()}`,
    );
    logger.info(`run_claude_task #${task.id} CT ${vmid}: ${status} via sentinel`);
    await recordClaudeDeployment(ctx, vmid, task.vm_id, parsed).catch((e) =>
      logger.warn(`run_claude_task #${task.id}: post-completion deployment record failed`, e),
    );
    return {
      status,
      completed_at: new Date().toISOString(),
      repo_url: parsed.repoUrl,
      result_summary: parsed.summary,
      detail: `completion sentinel: ${raw.trim()}`,
    };
  };

  if (probe.sentinel) return finishFromSentinel(probe.sentinel);

  const expired =
    task.expires_at && Number.isFinite(parseSqliteUtc(task.expires_at))
      ? Date.now() > parseSqliteUtc(task.expires_at)
      : false;
  if (expired) {
    await killSession(ctx, vmid, task.tmux_session);
    const summary = `wall-clock timeout (${task.expires_at}) — tmux session killed`;
    ctx.repo.finishClaudeTask(task.id, "timed_out", { summary });
    ctx.repo.addLog(task.vm_id, "claude_task", `run_claude_task #${task.id} timed_out — ${summary}`);
    logger.warn(`run_claude_task #${task.id} CT ${vmid}: timed out, killed tmux ${task.tmux_session}`);
    return { status: "timed_out", completed_at: new Date().toISOString(), repo_url: null, result_summary: summary, detail: summary };
  }

  if (probe.reachable && !probe.alive) {
    // Double-check the sentinel in case it landed as the session was closing.
    const again = await probeClaudeTask(ctx, vmid, task);
    if (again.sentinel) return finishFromSentinel(again.sentinel);
    const summary = "Claude Code session ended without writing a completion sentinel";
    ctx.repo.finishClaudeTask(task.id, "failed", { summary });
    ctx.repo.addLog(task.vm_id, "claude_task", `run_claude_task #${task.id} failed — ${summary}`);
    logger.warn(`run_claude_task #${task.id} CT ${vmid}: tmux session gone, no sentinel`);
    return { status: "failed", completed_at: new Date().toISOString(), repo_url: null, result_summary: summary, detail: summary };
  }

  return {
    status: "running",
    completed_at: null,
    repo_url: null,
    result_summary: null,
    detail: probe.reachable ? "session running" : "container unreachable — will retry",
  };
}

/**
 * When a completed task reports a repo it created (and optionally a tunnel
 * hostname), record a deployments row so the dashboard drawer shows the same
 * repo / tunnel state it does for deploy_app, and run one REAL tunnel health
 * check (never assume healthy — handoff item #3). Best-effort.
 */
async function recordClaudeDeployment(
  ctx: AppContext,
  vmid: number,
  vmDbId: number,
  parsed: SentinelPayload,
): Promise<void> {
  if (!parsed.repoUrl) return;
  const dep = ctx.repo.insertDeployment({
    vmId: vmDbId,
    repoUrl: parsed.repoUrl,
    branch: null,
    startCommand: null,
  });
  ctx.repo.finishDeployment(dep.id, "running", null);
  if (parsed.tunnelHostname) {
    await checkTunnelStatus(ctx, vmid, { hostname: parsed.tunnelHostname, retries: 3 });
  }
}

export async function getClaudeTaskStatus(
  ctx: AppContext,
  vmid: number,
  opts: { tailLines?: number } = {},
): Promise<ClaudeTaskStatusResult> {
  const row = requireOwnedVm(ctx, vmid);
  const task = ctx.repo.latestClaudeTask(row.id);
  if (!task) {
    throw new ToolError(`No run_claude_task has been launched on CT ${vmid} yet.`);
  }
  const res = await resolveClaudeTask(ctx, task, vmid);
  const fresh = ctx.repo.latestClaudeTask(row.id) ?? task;

  let paneTail: string | undefined;
  if (res.status === "running" && opts.tailLines !== 0) {
    paneTail = await capturePaneTail(ctx, vmid, task.tmux_session, opts.tailLines ?? 40);
  }

  return {
    vmid,
    task_id: task.id,
    status: res.status,
    session_url: fresh.session_url,
    tmux_session: task.tmux_session,
    sentinel_path: task.sentinel_path,
    repo_url: res.repo_url ?? fresh.repo_url,
    result_summary: res.result_summary ?? fresh.result_summary,
    started_at: task.started_at,
    expires_at: task.expires_at,
    completed_at: res.completed_at ?? fresh.completed_at,
    detail: res.detail,
    pane_tail: paneTail,
  };
}

/** Sweep every running task and finalize any that completed / died / timed out. */
export async function reapClaudeTasks(ctx: AppContext): Promise<void> {
  const running = ctx.repo.listRunningClaudeTasks();
  if (running.length === 0) return;
  logger.debug(`claude-task reaper: ${running.length} running task(s)`);
  for (const t of running) {
    try {
      const res = await resolveClaudeTask(ctx, t, t.vmid);
      if (res.status !== "running") {
        logger.info(`claude-task reaper: task #${t.id} CT ${t.vmid} → ${res.status}`);
      }
    } catch (err) {
      logger.warn(`claude-task reaper: task #${t.id} CT ${t.vmid} probe failed`, err);
    }
  }
}

let reaperTimer: NodeJS.Timeout | undefined;

/** Start the periodic reaper. No-op if already started. */
export function startClaudeTaskReaper(ctx: AppContext, intervalMs = 60_000): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    reapClaudeTasks(ctx).catch((err) => logger.warn("claude-task reaper sweep failed", err));
  }, intervalMs);
  // Don't hold the process open for the timer.
  reaperTimer.unref?.();
  logger.info(`claude-task reaper started (every ${Math.round(intervalMs / 1_000)}s)`);
}
