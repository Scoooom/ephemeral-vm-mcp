import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import dotenv from "dotenv";

/**
 * Two sources of configuration:
 *  1. /opt/.proxmox-api-info  — Proxmox API credentials only (never committed)
 *  2. process.env / .env      — everything else (app behaviour)
 */

const PROXMOX_CRED_PATH = process.env.PROXMOX_CRED_PATH ?? "/opt/.proxmox-api-info";

export interface ProxmoxConfig {
  /** e.g. https://pve2.scooom.com:8006/api2/json */
  apiBase: string;
  host: string;
  tokenId: string;
  tokenSecret: string;
  node: string;
  /** the ONLY storage ephemeral rootfs is allocated on — never local-zfs */
  storage: string;
  templateId: number;
  /** resource pool every ephemeral container is placed in ('' disables pool assignment) */
  pool: string;
}

export interface NetworkConfig {
  bridge: string;
  subnet: string;
  gateway: string;
  cidrBits: number;
  rangeStart: number;
  rangeEnd: number;
  reserved: number[];
}

export interface SshConfig {
  user: string;
  privateKeyPath: string;
  privateKey: Buffer;
}

export interface HttpConfig {
  port: number;
  host: string;
  authToken: string | null;
}

export interface DashboardConfig {
  /** Whether to start the dashboard listener (only relevant in --http mode). */
  enabled: boolean;
  port: number;
  host: string;
  /** WebAuthn Relying Party ID — the registrable domain the dashboard is served from. */
  rpId: string;
  /** WebAuthn expected origin, e.g. https://proxweb.scooom.com. */
  origin: string;
  /** HMAC key for signing session/challenge cookies. Required when enabled. */
  sessionSecret: string | null;
  /** If set, registering a new passkey requires this token (mitigates trust-on-first-use). */
  enrollToken: string | null;
}

export interface AppConfig {
  proxmox: ProxmoxConfig;
  network: NetworkConfig;
  ssh: SshConfig;
  http: HttpConfig;
  dashboard: DashboardConfig;
  dbPath: string;
  /**
   * Wall-clock safety valve for run_claude_task. Remote Control sessions are
   * interactive and never exit on their own, and `--max-turns` is a
   * headless-mode (`claude -p`) flag that does not apply to them — so a
   * detached RC session that loops forever would burn plan quota indefinitely.
   * get_claude_task_status and the background reaper kill any tmux session
   * still running past this many seconds and mark the task `timed_out`.
   */
  claudeTaskTimeoutSeconds: number;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function req(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value.trim();
}

function num(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Configuration ${name} is not a number: ${value}`);
  return n;
}

export function loadConfig(): AppConfig {
  // App env (.env in cwd, if present). Does not override real env vars.
  dotenv.config({ quiet: true });

  // Proxmox credentials (separate file, dotenv format).
  const creds = dotenv.parse(readFileSync(PROXMOX_CRED_PATH));
  const host = req("PROXMOX_HOST", creds.PROXMOX_HOST);
  const tokenId = req("PROXMOX_TOKEN_ID", creds.PROXMOX_TOKEN_ID);
  const tokenSecret = req("PROXMOX_TOKEN_SECRET", creds.PROXMOX_TOKEN_SECRET);

  const privateKeyPath = expandHome(process.env.SSH_PRIVATE_KEY_PATH ?? "~/.ssh/id_rsa");

  const reserved = (process.env.EPHEMERAL_RESERVED ?? "1,113,115")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));

  const dbPathRaw = process.env.MCP_DB_PATH ?? "./data/ephemeral.db";
  const dbPath = isAbsolute(dbPathRaw) ? dbPathRaw : resolve(process.cwd(), dbPathRaw);

  const dashRpId = process.env.DASHBOARD_RP_ID ?? "proxweb.scooom.com";

  return {
    proxmox: {
      apiBase: `https://${host}:8006/api2/json`,
      host,
      tokenId,
      tokenSecret,
      node: process.env.PROXMOX_NODE ?? "pve2",
      storage: process.env.PROXMOX_STORAGE ?? "media",
      templateId: num("PROXMOX_TEMPLATE_ID", process.env.PROXMOX_TEMPLATE_ID, 113),
      pool: process.env.EPHEMERAL_POOL ?? "ephemeral",
    },
    network: {
      bridge: process.env.EPHEMERAL_BRIDGE ?? "vmbr2",
      subnet: process.env.EPHEMERAL_SUBNET ?? "10.10.30.0",
      gateway: process.env.EPHEMERAL_GATEWAY ?? "10.10.30.1",
      cidrBits: num("EPHEMERAL_CIDR_BITS", process.env.EPHEMERAL_CIDR_BITS, 24),
      rangeStart: num("EPHEMERAL_RANGE_START", process.env.EPHEMERAL_RANGE_START, 10),
      rangeEnd: num("EPHEMERAL_RANGE_END", process.env.EPHEMERAL_RANGE_END, 254),
      reserved,
    },
    ssh: {
      user: process.env.SSH_USER ?? "root",
      privateKeyPath,
      privateKey: readFileSync(privateKeyPath),
    },
    http: {
      port: num("MCP_HTTP_PORT", process.env.MCP_HTTP_PORT, 8788),
      host: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
      authToken: process.env.MCP_AUTH_TOKEN?.trim() || null,
    },
    dashboard: {
      enabled: (process.env.DASHBOARD_ENABLED ?? "1").trim() !== "0",
      port: num("DASHBOARD_PORT", process.env.DASHBOARD_PORT, 8789),
      host: process.env.DASHBOARD_HOST ?? "127.0.0.1",
      rpId: dashRpId,
      origin: process.env.DASHBOARD_ORIGIN ?? `https://${dashRpId}`,
      sessionSecret: process.env.DASHBOARD_SESSION_SECRET?.trim() || null,
      enrollToken: process.env.DASHBOARD_ENROLL_TOKEN?.trim() || null,
    },
    dbPath,
    claudeTaskTimeoutSeconds: num(
      "CLAUDE_TASK_TIMEOUT_SECONDS",
      process.env.CLAUDE_TASK_TIMEOUT_SECONDS,
      3_600,
    ),
  };
}
