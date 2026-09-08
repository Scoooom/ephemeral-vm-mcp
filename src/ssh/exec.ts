import { Client, type ClientChannel } from "ssh2";
import { logger } from "../logger.js";

export interface ExecResult {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  host: string;
  cmd: string;
  timeoutMs: number;
  user: string;
  privateKey: Buffer;
  env?: Record<string, string>;
  connectTimeoutMs?: number;
  connectRetries?: number;
  connectRetryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The single SSH execution primitive. `exec_command`, `run_post_create_script`
 * and `run_claude_task` are all thin wrappers over this.
 *
 * - Retries the initial connection (a freshly-started container may still be
 *   booting sshd).
 * - Host-key verification is disabled: ephemeral containers reuse IPs from a
 *   small pool, so a pinned known_hosts entry would be wrong more often than
 *   right. Documented tradeoff.
 * - Never throws for a non-zero exit code — the caller decides what that means.
 *   Throws only for connection failure that outlasts the retries.
 */
export async function execCommand(opts: ExecOptions): Promise<ExecResult> {
  const retries = opts.connectRetries ?? 10;
  const retryDelay = opts.connectRetryDelayMs ?? 3_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await once(opts);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries + 1) break;
      logger.debug(`ssh ${opts.host}: connect attempt ${attempt} failed (${describe(err)}), retrying`);
      await sleep(retryDelay);
    }
  }
  throw new Error(
    `SSH to ${opts.user}@${opts.host} failed after ${retries + 1} attempt(s): ${describe(lastErr)}`,
  );
}

function once(opts: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      fn();
    };

    conn.on("ready", () => {
      const shellCmd = buildCommand(opts.cmd, opts.env);
      conn.exec(shellCmd, (err: Error | undefined, stream: ClientChannel) => {
        if (err) return done(() => reject(err));

        timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.signal("KILL");
          } catch {
            /* ignore */
          }
          done(() => resolve({ code: null, stdout, stderr, timedOut: true }));
        }, opts.timeoutMs);

        stream.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        stream.on("close", (code: number | null, signal?: string) => {
          done(() => resolve({ code, signal, stdout, stderr, timedOut }));
        });
      });
    });

    conn.on("error", (err) => done(() => reject(err)));

    conn.connect({
      host: opts.host,
      port: 22,
      username: opts.user,
      privateKey: opts.privateKey,
      readyTimeout: opts.connectTimeoutMs ?? 10_000,
      // Ephemeral hosts with recycled IPs — see the module doc comment.
      hostVerifier: () => true,
    });
  });
}

/**
 * Prefix `KEY=value` exports rather than relying on the SSH `env` channel
 * (sshd usually restricts `AcceptEnv`). Values are single-quoted safely.
 */
function buildCommand(cmd: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return cmd;
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("; ");
  return `${exports}; ${cmd}`;
}

export function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string; level?: string })?.code;
  const level = (err as { level?: string })?.level;
  return (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNRESET" ||
    level === "client-timeout" ||
    /Timed out while waiting for handshake/i.test(describe(err))
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
