import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { openDb } from "./db/index.js";
import { createProxmox, type Proxmox } from "./proxmox/index.js";
import { loadConfig } from "./config.js";

/** Shared state handed to every MCP tool and to the helper scripts. */
export interface AppContext {
  cfg: AppConfig;
  db: Db;
  repo: Repo;
  pve: Proxmox;
}

export function createContext(cfg = loadConfig()): AppContext {
  const db = openDb(cfg.dbPath);
  const repo = new Repo(db);
  const pve = createProxmox(cfg.proxmox);
  return { cfg, db, repo, pve };
}
