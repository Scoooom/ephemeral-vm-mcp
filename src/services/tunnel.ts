import axios from "axios";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import { requireOwnedVm } from "./ownership.js";
import { runOnContainer } from "./remote.js";

export interface TunnelCheckResult {
  vmid: number;
  hostname: string | null;
  hostname_source: "argument" | "deployment" | "container" | "none";
  cloudflared_active: boolean;
  http_status: number | null;
  healthy: boolean;
  attempts: number;
  detail: string;
}

export interface TunnelCheckOptions {
  hostname?: string;
  path?: string;
  retries?: number;
  intervalSeconds?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalise a hostname or URL to a bare host (no scheme, no path). */
function bareHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
}

/**
 * Real health check for a container's Cloudflare tunnel — does NOT create one.
 * Resolves the public hostname (explicit arg → recorded deployment → the
 * container's own cloudflared config), confirms `cloudflared` is running on the
 * container, and probes the public hostname over HTTPS. A 5xx (esp. 502/530 —
 * "origin down") counts as unhealthy. Optionally polls until healthy so a
 * `run_claude_task` workflow can wait for the tunnel in one call.
 */
export async function checkTunnelStatus(
  ctx: AppContext,
  vmid: number,
  opts: TunnelCheckOptions = {},
): Promise<TunnelCheckResult> {
  const row = requireOwnedVm(ctx, vmid);
  const deployment = ctx.repo.latestDeployment(row.id);
  const path = opts.path && opts.path.startsWith("/") ? opts.path : `/${opts.path ?? ""}`;
  const retries = Math.max(0, Math.min(opts.retries ?? 0, 30));
  const intervalMs = Math.max(1, Math.min(opts.intervalSeconds ?? 10, 60)) * 1_000;

  let hostname: string | null = null;
  let hostnameSource: TunnelCheckResult["hostname_source"] = "none";
  if (opts.hostname && opts.hostname.trim()) {
    hostname = bareHost(opts.hostname);
    hostnameSource = "argument";
  } else if (deployment?.tunnel_hostname) {
    hostname = bareHost(deployment.tunnel_hostname);
    hostnameSource = "deployment";
  } else {
    const discovered = await discoverHostnameOnContainer(ctx, vmid);
    if (discovered) {
      hostname = discovered;
      hostnameSource = "container";
    }
  }

  const cloudflaredActive = await isCloudflaredActive(ctx, vmid);

  let httpStatus: number | null = null;
  let attempts = 0;
  let healthy = false;

  if (hostname) {
    for (let i = 0; i <= retries; i++) {
      attempts++;
      httpStatus = await probe(`https://${hostname}${path}`);
      healthy = httpStatus !== null && httpStatus < 500;
      if (healthy) break;
      if (i < retries) await sleep(intervalMs);
    }
  }

  const detail = hostname
    ? `${hostname}${path} → ${httpStatus ?? "no response"} (cloudflared ${cloudflaredActive ? "active" : "inactive"})`
    : "no tunnel hostname could be resolved for this container";

  const status = healthy
    ? `healthy:${httpStatus}`
    : `unhealthy:${httpStatus ?? "noresponse"}`;
  if (deployment) ctx.repo.recordTunnelCheck(deployment.id, hostname, status);
  ctx.repo.addLog(row.id, "deploy", `tunnel check — ${detail} — healthy=${healthy} attempts=${attempts}`);
  logger.info(`tunnel check CT ${vmid}: ${detail} healthy=${healthy}`);

  return {
    vmid,
    hostname,
    hostname_source: hostnameSource,
    cloudflared_active: cloudflaredActive,
    http_status: httpStatus,
    healthy,
    attempts,
    detail,
  };
}

async function probe(url: string): Promise<number | null> {
  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    return res.status;
  } catch {
    return null;
  }
}

async function isCloudflaredActive(ctx: AppContext, vmid: number): Promise<boolean> {
  const r = await runOnContainer(
    ctx,
    vmid,
    "systemctl is-active cloudflared 2>/dev/null || true",
    { timeoutMs: 20_000 },
  ).catch(() => null);
  return !!r && r.stdout.trim() === "active";
}

async function discoverHostnameOnContainer(ctx: AppContext, vmid: number): Promise<string | null> {
  const r = await runOnContainer(
    ctx,
    vmid,
    "grep -hoE 'hostname: *[A-Za-z0-9._-]+' /etc/cloudflared/*.yml /etc/cloudflared/*.yaml 2>/dev/null | head -n1 | awk '{print $2}'",
    { timeoutMs: 20_000 },
  ).catch(() => null);
  const host = r?.stdout.trim();
  return host ? bareHost(host) : null;
}
