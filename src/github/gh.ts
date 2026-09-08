import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface GhResult {
  stdout: string;
  stderr: string;
}

/**
 * Run the `gh` CLI on this host (mcpProx), which is already authenticated
 * (`gh auth status` → Scoooom). This is the only place the server shells out to
 * a local binary; keep `gh` usage funnelled through here.
 *
 * Throws if `gh` is missing from PATH or exits non-zero — the caller's
 * `handler(...)` wrapper turns that into an `isError` tool result.
 */
export async function gh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<GhResult> {
  try {
    const { stdout, stderr } = await pExecFile("gh", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string | Buffer; message?: string };
    if (e.code === "ENOENT") {
      throw new Error("`gh` CLI not found on PATH — install/authenticate the GitHub CLI on this host.");
    }
    const detail = (e.stderr ? e.stderr.toString() : e.message ?? String(err)).trim();
    throw new Error(`gh ${args.join(" ")} failed: ${detail}`);
  }
}
