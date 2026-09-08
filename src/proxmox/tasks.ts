import type { ProxmoxClient } from "./client.js";
import type { PveTaskLogLine, PveTaskStatus } from "./types.js";
import { logger } from "../logger.js";

export interface Upid {
  raw: string;
  node: string;
  type: string;
  id: string;
  user: string;
}

/**
 * UPID format:
 *   UPID:<node>:<pid-hex>:<pstart-hex>:<starttime-hex>:<type>:<id>:<user>:
 */
export function parseUpid(upid: string): Upid {
  const parts = upid.split(":");
  if (parts[0] !== "UPID" || parts.length < 8) {
    throw new Error(`Not a valid UPID: ${upid}`);
  }
  return { raw: upid, node: parts[1], type: parts[5], id: parts[6], user: parts[7] };
}

export class ProxmoxTaskError extends Error {
  constructor(
    message: string,
    readonly upid: string,
    readonly exitStatus: string,
    readonly log: string[],
  ) {
    super(message);
    this.name = "ProxmoxTaskError";
  }
}

export class ProxmoxTaskTimeout extends Error {
  constructor(readonly upid: string, readonly waitedMs: number) {
    super(`Proxmox task ${upid} did not finish within ${Math.round(waitedMs / 1000)}s`);
    this.name = "ProxmoxTaskTimeout";
  }
}

export interface TaskResult {
  upid: string;
  exitStatus: string;
  log: string[];
}

export interface ExecTaskOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a Proxmox task (identified by its UPID) to completion.
 *
 * Mutating Proxmox calls (clone, start, stop, destroy, snapshot, rollback)
 * return a UPID immediately and continue asynchronously on the node. No
 * mutating tool should report success until this resolves.
 *
 * Resolves with the last ~20 log lines on success (`exitstatus === "OK"`),
 * throws `ProxmoxTaskError` on any other exit status, `ProxmoxTaskTimeout` if
 * it runs past `timeoutMs`.
 */
export async function execProxmoxTask(
  client: ProxmoxClient,
  upid: string,
  opts: ExecTaskOptions = {},
): Promise<TaskResult> {
  const { node } = parseUpid(upid);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_500;
  const encoded = encodeURIComponent(upid);
  const started = Date.now();

  logger.debug(`waiting on task ${upid}`);

  for (;;) {
    if (opts.signal?.aborted) throw new Error(`Aborted while waiting on task ${upid}`);

    const status = await client.get<PveTaskStatus>(
      `/nodes/${node}/tasks/${encoded}/status`,
    );

    if (status.status === "stopped") {
      const exit = status.exitstatus ?? "unknown";
      const log = await fetchTaskLog(client, node, encoded);
      if (exit === "OK") {
        logger.debug(`task ${upid} finished OK`);
        return { upid, exitStatus: exit, log };
      }
      throw new ProxmoxTaskError(
        `Proxmox task failed (${exit})` + (log.length ? `:\n${log.slice(-20).join("\n")}` : ""),
        upid,
        exit,
        log,
      );
    }

    if (Date.now() - started > timeoutMs) {
      throw new ProxmoxTaskTimeout(upid, Date.now() - started);
    }
    await sleep(pollIntervalMs);
  }
}

async function fetchTaskLog(
  client: ProxmoxClient,
  node: string,
  encodedUpid: string,
): Promise<string[]> {
  try {
    const lines = await client.get<PveTaskLogLine[]>(
      `/nodes/${node}/tasks/${encodedUpid}/log`,
      { start: 0, limit: 100 },
    );
    return (lines ?? []).map((l) => l.t);
  } catch {
    return [];
  }
}
