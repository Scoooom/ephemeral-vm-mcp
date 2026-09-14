import { createContext } from "../context.js";
import { createVm } from "../services/create.js";

interface Args {
  cores?: number;
  memory_mb?: number;
  disk_gb?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--cores" && flag !== "--memory-mb" && flag !== "--disk-gb") {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[++i];
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new Error(`${flag} requires an integer argument, got '${value}'`);
    }
    switch (flag) {
      case "--cores":
        args.cores = n;
        break;
      case "--memory-mb":
        args.memory_mb = n;
        break;
      case "--disk-gb":
        args.disk_gb = n;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = createContext();
  const name = `cli-${Date.now()}`;
  const result = await createVm(ctx, {
    name,
    task_description: "Created via CLI",
    cores: args.cores,
    memory_mb: args.memory_mb,
    disk_gb: args.disk_gb,
    tags: "cli-created",
  });
  // The ONLY thing this script writes to stdout — the local wrapper parses
  // this line. Everything else (logger.*) goes to stderr.
  process.stdout.write(JSON.stringify(result) + "\n");
  ctx.db.close();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
