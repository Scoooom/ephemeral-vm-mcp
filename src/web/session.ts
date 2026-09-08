import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Tiny stateless signed-token helper for the dashboard's session and WebAuthn
 * challenge cookies. Token = base64url(JSON payload) + "." + base64url(HMAC).
 * No dependency, same constant-time compare style as the MCP bearer check.
 */

const SESSION_COOKIE = "dash_session";
const CHALLENGE_COOKIE = "dash_chal";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export function sign(payload: unknown, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verify<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---- cookie parsing (no cookie-parser dependency) --------------------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number): void {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  res.append("Set-Cookie", attrs.join("; "));
}

function clearCookie(res: Response, name: string): void {
  res.append("Set-Cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// ---- session --------------------------------------------------------

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

export function issueSession(res: Response, secret: string, sub = "dashboard"): void {
  const now = Date.now();
  const token = sign({ sub, iat: now, exp: now + SESSION_TTL_MS } satisfies SessionPayload, secret);
  setCookie(res, SESSION_COOKIE, token, SESSION_TTL_MS);
}

export function clearSession(res: Response): void {
  clearCookie(res, SESSION_COOKIE);
}

export function hasValidSession(req: Request, secret: string): boolean {
  const p = verify<SessionPayload>(readCookie(req, SESSION_COOKIE), secret);
  return !!p && typeof p.exp === "number" && p.exp > Date.now();
}

// ---- WebAuthn challenge --------------------------------------------

interface ChallengePayload {
  kind: "reg" | "auth";
  challenge: string;
  exp: number;
}

export function issueChallenge(res: Response, secret: string, kind: "reg" | "auth", challenge: string): void {
  const token = sign(
    { kind, challenge, exp: Date.now() + CHALLENGE_TTL_MS } satisfies ChallengePayload,
    secret,
  );
  setCookie(res, CHALLENGE_COOKIE, token, CHALLENGE_TTL_MS);
}

export function takeChallenge(req: Request, res: Response, secret: string, kind: "reg" | "auth"): string | null {
  const p = verify<ChallengePayload>(readCookie(req, CHALLENGE_COOKIE), secret);
  clearCookie(res, CHALLENGE_COOKIE);
  if (!p || p.kind !== kind || p.exp <= Date.now()) return null;
  return p.challenge;
}
