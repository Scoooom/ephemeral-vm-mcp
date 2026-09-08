#!/usr/bin/env node
import { createContext } from "./context.js";
import { createServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";
import { startDashboard } from "./web/dashboard.js";
import { startClaudeTaskReaper } from "./services/claudeTask.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http") || process.env.MCP_HTTP === "1";
  const ctx = createContext();

  logger.info(
    `ephemeral-vm-mcp starting (node=${ctx.cfg.proxmox.node}, storage=${ctx.cfg.proxmox.storage}, ` +
      `db=${ctx.cfg.dbPath}, transport=${useHttp ? "http" : "stdio"})`,
  );

  if (useHttp) {
    await startHttp(ctx);
    if (ctx.cfg.dashboard.enabled) {
      await startDashboard(ctx);
    }
  } else {
    await startStdio(createServer(ctx));
  }

  // Finalize run_claude_task sessions that completed, died, or blew their
  // wall-clock budget while nothing was polling get_claude_task_status.
  startClaudeTaskReaper(ctx);

  const shutdown = () => {
    logger.info("shutting down");
    try {
      ctx.db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("fatal", err);
  process.exit(1);
});
