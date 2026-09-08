import { Router, type Request, type RequestHandler } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { DashboardConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import {
  clearSession,
  hasValidSession,
  issueChallenge,
  issueSession,
  takeChallenge,
} from "./session.js";

const RP_NAME = "Ephemeral LXC MCP";
const USER_ID = new TextEncoder().encode("dashboard");
const USER_NAME = "dashboard";

/**
 * Passkey (WebAuthn) authentication for the dashboard, trust-on-first-use:
 * the first browser to complete registration owns the dashboard. Set
 * DASHBOARD_ENROLL_TOKEN to require a shared secret for that first enrollment.
 */
export function authRouter(ctx: AppContext, cfg: DashboardConfig): Router {
  const secret = cfg.sessionSecret!; // guarded in startDashboard
  const r = Router();

  const enrollmentAllowed = (req: Request): "ok" | "closed" | "bad_token" => {
    if (ctx.repo.countCredentials() === 0) {
      if (!cfg.enrollToken) return "ok";
      const raw = req.get("x-enroll-token") ?? (req.body as { enrollToken?: string })?.enrollToken;
      const supplied = typeof raw === "string" ? raw.trim() : "";
      return supplied === cfg.enrollToken ? "ok" : "bad_token";
    }
    // Further passkeys may only be added from an already-authenticated session.
    return hasValidSession(req, secret) ? "ok" : "closed";
  };

  r.get("/state", (req, res) => {
    res.json({
      enrolled: ctx.repo.countCredentials() > 0,
      authed: hasValidSession(req, secret),
      enrollTokenRequired: ctx.repo.countCredentials() === 0 && !!cfg.enrollToken,
    });
  });

  r.post("/register/options", async (req, res) => {
    const gate = enrollmentAllowed(req);
    if (gate !== "ok") {
      res.status(403).json({ error: gate === "bad_token" ? "bad_enroll_token" : "enrollment_closed" });
      return;
    }
    const existing = ctx.repo.listCredentials();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: cfg.rpId,
      userID: USER_ID,
      userName: USER_NAME,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: splitTransports(c.transports),
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    issueChallenge(res, secret, "reg", options.challenge);
    res.json(options);
  });

  r.post("/register/verify", async (req, res) => {
    const gate = enrollmentAllowed(req);
    if (gate !== "ok") {
      res.status(403).json({ error: gate === "bad_token" ? "bad_enroll_token" : "enrollment_closed" });
      return;
    }
    const expectedChallenge = takeChallenge(req, res, secret, "reg");
    if (!expectedChallenge) {
      res.status(400).json({ error: "challenge_expired" });
      return;
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body.attResp ?? req.body,
        expectedChallenge,
        expectedOrigin: cfg.origin,
        expectedRPID: cfg.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      logger.warn("passkey registration verify failed", err);
      res.status(400).json({ error: "verification_failed" });
      return;
    }
    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "not_verified" });
      return;
    }
    const { credential } = verification.registrationInfo;
    ctx.repo.addCredential({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports?.join(",") ?? null,
      label: typeof req.body.label === "string" ? req.body.label.slice(0, 100) : null,
    });
    issueSession(res, secret);
    logger.info(`dashboard passkey registered (${credential.id.slice(0, 12)}…)`);
    res.json({ ok: true });
  });

  r.post("/login/options", async (_req, res) => {
    const creds = ctx.repo.listCredentials();
    const options = await generateAuthenticationOptions({
      rpID: cfg.rpId,
      userVerification: "preferred",
      allowCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: splitTransports(c.transports),
      })),
    });
    issueChallenge(res, secret, "auth", options.challenge);
    res.json(options);
  });

  r.post("/login/verify", async (req, res) => {
    const expectedChallenge = takeChallenge(req, res, secret, "auth");
    if (!expectedChallenge) {
      res.status(400).json({ error: "challenge_expired" });
      return;
    }
    const authResp = req.body.authResp ?? req.body;
    const stored = ctx.repo.getCredentialByCredId(authResp?.id);
    if (!stored) {
      res.status(400).json({ error: "unknown_credential" });
      return;
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: authResp,
        expectedChallenge,
        expectedOrigin: cfg.origin,
        expectedRPID: cfg.rpId,
        requireUserVerification: false,
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(stored.public_key),
          counter: stored.counter,
          transports: splitTransports(stored.transports),
        },
      });
    } catch (err) {
      logger.warn("passkey auth verify failed", err);
      res.status(400).json({ error: "verification_failed" });
      return;
    }
    if (!verification.verified) {
      res.status(401).json({ error: "not_verified" });
      return;
    }
    ctx.repo.bumpCredential(stored.credential_id, verification.authenticationInfo.newCounter);
    issueSession(res, secret);
    res.json({ ok: true });
  });

  r.post("/logout", (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  return r;
}

/** 401 for /api/*, redirect to the login page for anything else. */
export function requireSession(cfg: DashboardConfig): RequestHandler {
  const secret = cfg.sessionSecret!;
  return (req, res, next) => {
    if (hasValidSession(req, secret)) {
      next();
      return;
    }
    if (req.originalUrl.startsWith("/api/")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.redirect(302, "/login.html");
  };
}

function splitTransports(v: string | null): ("ble" | "hybrid" | "internal" | "nfc" | "usb" | "cable" | "smart-card")[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean) as never;
}
