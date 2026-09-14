#!/usr/bin/env -S npx tsx
/**
 * Spins up a new ephemeral container from your own machine, without the MCP
 * server needing to expose an API token to the outside world: this shells
 * out to the system `ssh` binary (your own key/agent/known_hosts/config
 * apply exactly as they would for `ssh root@host`), runs the same
 * create-VM code the dashboard uses on the MCP host itself, and prints the
 * result.
 *
 * Usage:
 *   npm run create-vm -- [--cores N] [--ram MiB] [--disk GiB]
 *
 * All flags are optional; omit any of them to get the server's defaults
 * (1 core / 512 MiB / the template's default disk size).
 *
 * Connection settings come from .env in the project root:
 *   EPHEMERAL_HOST_SSH_TARGET   default: root@10.10.30.115
 *   EPHEMERAL_HOST_SSH_KEY      optional; passed as `ssh -i <path>` if set —
 *                               otherwise ssh's own config/agent decide
 *   EPHEMERAL_HOST_REMOTE_PATH  default: /opt/ephemeral-vm-mcp
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv();

interface Args {
  cores?: number;
  memoryMb?: number;
  diskGb?: number;
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
  }

  const target = process.env.EPHEMERAL_HOST_SSH_TARGET ?? "root@10.10.30.115";
  const remotePath = process.env.EPHEMERAL_HOST_REMOTE_PATH ?? "/opt/ephemeral-vm-mcp";
  const keyPath = process.env.EPHEMERAL_HOST_SSH_KEY;

  const remoteArgs = ["dist/cli/create-vm-remote.js"];
  if (args.cores !== undefined) remoteArgs.push("--cores", String(args.cores));
  if (args.memoryMb !== undefined) remoteArgs.push("--memory-mb", String(args.memoryMb));
  if (args.diskGb !== undefined) remoteArgs.push("--disk-gb", String(args.diskGb));
  const remoteCommand = `cd ${shQuote(remotePath)} && node ${remoteArgs.map(shQuote).join(" ")}`;

  const sshArgs: string[] = [];
  if (keyPath) sshArgs.push("-i", expandHome(keyPath));
  sshArgs.push(target, remoteCommand);

  const summary = describeRequest(args);
  console.error(`Creating container on ${target}${summary} — this can take a minute…`);

  const child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.on("error", (err) => {
    console.error(`Failed to run ssh: ${err.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    if (code !== 0) {
      console.error(`\nssh exited with code ${code}`);
      process.exit(code ?? 1);
    }
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    let result: { vmid: number; ip: string; name: string; status: string };
    try {
      result = JSON.parse(line ?? "");
    } catch {
      console.error("Could not parse a result from the remote host. Raw output:");
      console.error(stdout);
      process.exit(1);
      return;
    }
    console.log(`Created CT ${result.vmid} — ${result.ip} (${result.name}, ${result.status})`);
  });
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      printUsage();
      process.exit(0);
    }
    if (flag !== "--cores" && flag !== "--ram" && flag !== "--memory-mb" && flag !== "--disk" && flag !== "--disk-gb") {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const raw = argv[++i];
    const n = Number(raw);
    if (raw === undefined || !Number.isInteger(n)) {
      throw new Error(`${flag} requires an integer argument`);
    }
    switch (flag) {
      case "--cores":
        args.cores = n;
        break;
      case "--ram":
      case "--memory-mb":
        args.memoryMb = n;
        break;
      case "--disk":
      case "--disk-gb":
        args.diskGb = n;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function describeRequest(args: Args): string {
  const parts: string[] = [];
  if (args.cores !== undefined) parts.push(`${args.cores} vCPU`);
  if (args.memoryMb !== undefined) parts.push(`${args.memoryMb} MiB`);
  if (args.diskGb !== undefined) parts.push(`${args.diskGb} GiB disk`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(p.replace(/^~/, homedir())) : p;
}

function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

function printUsage(): void {
  console.error(
    `Usage: npm run create-vm -- [--cores N] [--ram MiB] [--disk GiB]\n\n` +
      `All flags optional — omit for the server's defaults (1 core / 512 MiB / template disk size).\n\n` +
      `Connection settings come from .env in the project root:\n` +
      `  EPHEMERAL_HOST_SSH_TARGET   default: root@10.10.30.115\n` +
      `  EPHEMERAL_HOST_SSH_KEY      optional -i path; unset = ssh's own config/agent\n` +
      `  EPHEMERAL_HOST_REMOTE_PATH  default: /opt/ephemeral-vm-mcp\n`,
  );
}

main();
