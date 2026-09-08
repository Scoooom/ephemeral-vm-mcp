import type { ProxmoxConfig } from "../config.js";
import { ProxmoxClient } from "./client.js";
import { Discovery } from "./discovery.js";
import { LxcApi } from "./lxc.js";

export * from "./client.js";
export * from "./tasks.js";
export * from "./lxc.js";
export * from "./discovery.js";
export * from "./types.js";

export interface Proxmox {
  client: ProxmoxClient;
  lxc: LxcApi;
  discovery: Discovery;
  node: string;
}

export function createProxmox(cfg: ProxmoxConfig): Proxmox {
  const client = new ProxmoxClient(cfg);
  const lxc = new LxcApi(client, cfg.node);
  const discovery = new Discovery(client, lxc, cfg.node);
  return { client, lxc, discovery, node: cfg.node };
}
