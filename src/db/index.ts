import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";
import { logger } from "../logger.js";

export type Db = Database.Database;

/**
 * Open (creating if needed) the SQLite database and bring the schema up to date.
 *
 * All DB access in this project goes through this module and `repo.ts`, so that
 * swapping to the built-in `node:sqlite` would be a change confined to here.
 */
export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  return db;
}

function runMigrations(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug(`db schema up to date (user_version=${current})`);
    return;
  }

  for (const m of pending) {
    logger.info(`applying migration v${m.version}: ${m.name}`);
    const tx = db.transaction(() => {
      db.exec(m.sql);
      // PRAGMA user_version does not accept bound parameters.
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
  logger.info(`db schema now at v${pending[pending.length - 1].version}`);
}
