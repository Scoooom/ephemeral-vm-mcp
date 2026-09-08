import { Router, type Response } from "express";
import type { AppContext } from "../context.js";
import type { LogPhase, VmRow } from "../db/repo.js";
import { logger } from "../logger.js";
import { destroyVm, rebootVm, startVm, stopVm } from "../services/lifecycle.js";
import { vmStatusWithDrift } from "../services/status.js";
import { checkTunnelStatus } from "../services/tunnel.js";
import { ToolError } from "../services/ownership.js";

const LOG_PHASES: LogPhase[] = ["post_create", "claude_task", "deploy", "teardown", "exec", "clone"];

/** Internal JSON API backing the dashboard. Mounted behind requireSession. */
export function apiRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/vms", (_req, res) => {
    res.json(ctx.repo.listActive().map(withAge));
  });

  r.get("/history", (req, res) => {
    const { name, from, to } = req.query as Record<string, string | undefined>;
    res.json(ctx.repo.listHistory({ name, from, to }).map(withAge));
  });

  r.get("/vms/:vmid", async (req, res) => {
    await handle(res, () => vmStatusWithDrift(ctx, parseVmid(req.params.vmid)));
  });

  r.get("/vms/:vmid/logs", (req, res) => {
    const vmid = parseVmid(req.params.vmid);
    const row = ctx.repo.getByVmid(vmid);
    if (!row) {
      res.status(404).json({ error: `no container record for CT ${vmid}` });
      return;
    }
    const phaseParam = (req.query.phase as string | undefined)?.trim();
    const phase = phaseParam && LOG_PHASES.includes(phaseParam as LogPhase) ? (phaseParam as LogPhase) : undefined;
    res.json({
      vmid,
      vm_id: row.id,
      phases: LOG_PHASES,
      logs: ctx.repo.listLogs(row.id, { phase, order: "asc", limit: 500 }),
    });
  });

  r.get("/scripts", (_req, res) => {
    res.json(ctx.repo.listScripts());
  });

  r.get("/scripts/:name", (req, res) => {
    const row = ctx.repo.getScript(req.params.name);
    if (!row) {
      res.status(404).json({ error: "no such script" });
      return;
    }
    res.json(row);
  });

  r.put("/scripts/:name", (req, res) => {
    const name = req.params.name.trim();
    const script = (req.body as { script?: unknown }).script;
    if (!name || typeof script !== "string" || script.length === 0) {
      res.status(400).json({ error: "name and non-empty script body are required" });
      return;
    }
    // Same write path as the set_post_create_script MCP tool.
    const row = ctx.repo.upsertScript(name, script);
    logger.info(`dashboard saved post-create script '${row.name}' (${script.length} bytes)`);
    res.json(row);
  });

  for (const [verb, fn] of [
    ["start", startVm],
    ["stop", stopVm],
    ["reboot", rebootVm],
    ["destroy", destroyVm],
  ] as const) {
    r.post(`/vms/:vmid/${verb}`, async (req, res) => {
      const vmid = parseVmid(req.params.vmid);
      logger.info(`dashboard ${verb} CT ${vmid}`);
      await handle(res, async () => {
        const result = await fn(ctx, vmid);
        return typeof result === "string" ? { action: verb, status: result } : { action: verb, ...result };
      });
    });
  }

  r.post("/vms/:vmid/check-tunnel", async (req, res) => {
    const vmid = parseVmid(req.params.vmid);
    logger.info(`dashboard check-tunnel CT ${vmid}`);
    await handle(res, async () => ({ action: "check-tunnel", ...(await checkTunnelStatus(ctx, vmid, { retries: 2 })) }));
  });

  return r;
}

function withAge(row: VmRow): VmRow & { age_seconds: number } {
  const started = Date.parse(row.created_at.replace(" ", "T") + "Z");
  return { ...row, age_seconds: Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0 };
}

function parseVmid(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ToolError(`Invalid VMID '${raw}'`);
  return n;
}

async function handle(res: Response, fn: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await fn());
  } catch (err) {
    if (err instanceof ToolError) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error("dashboard api error", err);
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
