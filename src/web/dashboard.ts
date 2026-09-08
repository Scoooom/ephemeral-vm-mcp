import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import { apiRouter } from "./api.js";
import { authRouter, requireSession } from "./auth.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../public");

/**
 * The human-facing web dashboard. A second Express listener in the same process
 * as the MCP HTTP transport, bound to localhost — the Cloudflare tunnel
 * (proxweb.scooom.com) is the only ingress. All auth is passkey-based (see
 * ./auth.ts); there is no bearer layer here.
 */
export async function startDashboard(ctx: AppContext): Promise<void> {
  const cfg = ctx.cfg.dashboard;
  if (!cfg.sessionSecret) {
    throw new Error(
      "DASHBOARD_SESSION_SECRET must be set to run the web dashboard " +
        "(or set DASHBOARD_ENABLED=0 to disable it).",
    );
  }

  const app = express();
  app.use(express.json({ limit: "512kb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "ephemeral-vm-mcp-dashboard" }));

  // Passkey ceremony endpoints — unauthenticated by nature.
  app.use("/api/auth", authRouter(ctx, cfg));

  // Gate the app shell so an unauthenticated visitor is bounced to the login page.
  const shell = (_req: express.Request, res: express.Response) => res.sendFile(join(PUBLIC_DIR, "index.html"));
  app.get("/", requireSession(cfg), shell);
  app.get("/index.html", requireSession(cfg), shell);

  // Static assets (login page, css, js, vendored WebAuthn browser lib).
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // Data + lifecycle API — session required.
  app.use("/api", requireSession(cfg), apiRouter(ctx));

  await new Promise<void>((resolve) => {
    app.listen(cfg.port, cfg.host, () => {
      logger.info(`dashboard ready on http://${cfg.host}:${cfg.port} (rpID=${cfg.rpId}, origin=${cfg.origin})`);
      resolve();
    });
  });
}
