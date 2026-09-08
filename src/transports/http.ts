import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../context.js";
import { createServer } from "../server.js";
import { logger } from "../logger.js";

/**
 * Streamable-HTTP transport. Bound to localhost only — the Cloudflare tunnel is
 * the sole ingress. A static bearer token (MCP_AUTH_TOKEN) is required on every
 * request as defense-in-depth behind the tunnel / Cloudflare Access.
 */
export async function startHttp(ctx: AppContext): Promise<void> {
  const { port, host, authToken } = ctx.cfg.http;
  if (!authToken) {
    throw new Error("MCP_AUTH_TOKEN must be set to run the HTTP transport (refusing to expose an unauthenticated endpoint).");
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "ephemeral-vm-mcp" }));

  app.use("/mcp", (req, res, next) => {
    if (!checkBearer(req.header("authorization"), authToken)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send an initialize request first." }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      // A fresh MCP server instance per session (shares the one AppContext).
      await createServer(ctx).connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  const bySession = async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(404).send("Unknown session");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      logger.info(`http transport ready on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7).trim());
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}
