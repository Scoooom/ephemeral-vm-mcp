import { Agent } from "node:https";
import axios, { AxiosError, type AxiosInstance } from "axios";
import type { ProxmoxConfig } from "../config.js";
import { logger } from "../logger.js";

export class ProxmoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly method?: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "ProxmoxError";
  }
}

/**
 * Thin wrapper over the Proxmox VE REST API.
 *
 * - Token auth via the `Authorization: PVEAPIToken=<id>=<secret>` header.
 * - TLS verification stays ON (pve2.scooom.com has a valid Let's Encrypt cert).
 * - Mutating calls send `application/x-www-form-urlencoded` (Proxmox's most
 *   reliable encoding; `URLSearchParams` URL-encodes `,` / `=` inside values).
 * - Every response is unwrapped from its `{ data: ... }` envelope.
 */
export class ProxmoxClient {
  private readonly http: AxiosInstance;

  constructor(cfg: ProxmoxConfig) {
    this.http = axios.create({
      baseURL: cfg.apiBase,
      timeout: 30_000,
      httpsAgent: new Agent({ keepAlive: true }),
      headers: {
        Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`,
      },
    });
  }

  async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>("GET", path, { params: query });
  }

  async post<T = string>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, { data: encodeForm(body) });
  }

  async put<T = null>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.request<T>("PUT", path, { data: encodeForm(body) });
  }

  async del<T = string>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>("DELETE", path, { params: query });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { params?: Record<string, unknown>; data?: string },
  ): Promise<T> {
    try {
      logger.debug(`pve ${method} ${path}`);
      const res = await this.http.request({
        method,
        url: path,
        params: opts.params,
        data: opts.data,
        headers: opts.data
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : undefined,
      });
      return (res.data?.data ?? null) as T;
    } catch (err) {
      throw toProxmoxError(err, method, path);
    }
  }
}

function encodeForm(body?: Record<string, unknown>): string | undefined {
  if (!body) return undefined;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") params.set(k, v ? "1" : "0");
    else params.set(k, String(v));
  }
  return params.toString();
}

function toProxmoxError(err: unknown, method: string, path: string): ProxmoxError {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const pveMsg =
      (err.response?.data as { message?: string; errors?: unknown })?.message ??
      JSON.stringify((err.response?.data as { errors?: unknown })?.errors ?? "") ??
      err.message;
    const msg = `Proxmox ${method} ${path} failed` + (status ? ` (${status})` : "") + `: ${String(pveMsg).trim()}`;
    return new ProxmoxError(msg, status, method, path);
  }
  return new ProxmoxError(`Proxmox ${method} ${path} failed: ${String(err)}`, undefined, method, path);
}
