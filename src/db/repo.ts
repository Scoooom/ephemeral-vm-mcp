import type { Db } from "./index.js";

export type VmStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "task_running"
  | "tearing_down"
  | "destroyed"
  | "error";

export type LogPhase =
  | "post_create"
  | "claude_task"
  | "deploy"
  | "teardown"
  | "exec"
  | "clone";

export interface VmRow {
  id: number;
  vmid: number;
  name: string;
  template_id: number;
  clone_type: "linked" | "full";
  cores: number;
  memory_mb: number;
  node: string;
  bridge: string;
  ip: string | null;
  status: VmStatus;
  task_description: string | null;
  tags: string | null;
  post_create_ran: string | null;
  created_at: string;
  destroyed_at: string | null;
  owned_by: string | null;
}

export interface PostCreateScriptRow {
  id: number;
  name: string;
  script: string;
  updated_at: string;
}

export interface VmSnapshotRow {
  id: number;
  vm_id: number;
  snapshot_name: string;
  created_at: string;
}

export interface VmLogRow {
  id: number;
  vm_id: number | null;
  phase: LogPhase;
  output: string | null;
  created_at: string;
}

export interface InsertVmInput {
  vmid: number;
  name: string;
  template_id: number;
  clone_type: "linked" | "full";
  cores: number;
  memory_mb: number;
  node: string;
  bridge: string;
  ip: string;
  task_description: string | null;
  tags: string | null;
}

export const OWNER = "ephemeral-mcp";

export class Repo {
  constructor(private readonly db: Db) {}

  // ---- vms ---------------------------------------------------------------

  /** Last octets of every non-destroyed VM that has an IP assigned. */
  usedOctets(): number[] {
    const rows = this.db
      .prepare(`SELECT ip FROM vms WHERE status != 'destroyed' AND ip IS NOT NULL`)
      .all() as { ip: string }[];
    const octets: number[] = [];
    for (const r of rows) {
      const last = Number(r.ip.split("/")[0].split(".").pop());
      if (Number.isInteger(last)) octets.push(last);
    }
    return octets;
  }

  vmidInUse(vmid: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM vms WHERE vmid = ? AND status != 'destroyed' LIMIT 1`)
      .get(vmid);
    return row !== undefined;
  }

  insertProvisioning(input: InsertVmInput): VmRow {
    const info = this.db
      .prepare(
        `INSERT INTO vms
           (vmid, name, template_id, clone_type, cores, memory_mb, node, bridge, ip,
            status, task_description, tags, owned_by)
         VALUES
           (@vmid, @name, @template_id, @clone_type, @cores, @memory_mb, @node, @bridge, @ip,
            'provisioning', @task_description, @tags, '${OWNER}')`,
      )
      .run(input as unknown as Record<string, unknown>);
    return this.getById(Number(info.lastInsertRowid))!;
  }

  /**
   * Run `fn` inside a single write transaction. Used so that allocating an IP
   * and inserting the row that claims it are atomic against concurrent clones.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getById(id: number): VmRow | undefined {
    return this.db.prepare(`SELECT * FROM vms WHERE id = ?`).get(id) as VmRow | undefined;
  }

  /** Most recent row for a vmid (there can be historical destroyed rows). */
  getByVmid(vmid: number): VmRow | undefined {
    return this.db
      .prepare(`SELECT * FROM vms WHERE vmid = ? ORDER BY id DESC LIMIT 1`)
      .get(vmid) as VmRow | undefined;
  }

  /** Active (non-destroyed) row for a vmid, or undefined. */
  getActiveByVmid(vmid: number): VmRow | undefined {
    return this.db
      .prepare(`SELECT * FROM vms WHERE vmid = ? AND status != 'destroyed' ORDER BY id DESC LIMIT 1`)
      .get(vmid) as VmRow | undefined;
  }

  listActive(): VmRow[] {
    return this.db
      .prepare(`SELECT * FROM vms WHERE status != 'destroyed' ORDER BY vmid`)
      .all() as VmRow[];
  }

  listAll(): VmRow[] {
    return this.db.prepare(`SELECT * FROM vms ORDER BY id DESC`).all() as VmRow[];
  }

  setStatus(id: number, status: VmStatus): void {
    this.db.prepare(`UPDATE vms SET status = ? WHERE id = ?`).run(status, id);
  }

  setIp(id: number, ip: string): void {
    this.db.prepare(`UPDATE vms SET ip = ? WHERE id = ?`).run(ip, id);
  }

  markPostCreateRan(id: number): void {
    this.db
      .prepare(`UPDATE vms SET post_create_ran = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(id);
  }

  markDestroyed(id: number): void {
    this.db
      .prepare(
        `UPDATE vms SET status = 'destroyed', destroyed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(id);
  }

  // ---- post_create_scripts --------------------------------------------

  upsertScript(name: string, script: string): PostCreateScriptRow {
    this.db
      .prepare(
        `INSERT INTO post_create_scripts (name, script, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(name) DO UPDATE SET script = excluded.script, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(name, script);
    return this.getScript(name)!;
  }

  getScript(name: string): PostCreateScriptRow | undefined {
    return this.db
      .prepare(`SELECT * FROM post_create_scripts WHERE name = ?`)
      .get(name) as PostCreateScriptRow | undefined;
  }

  listScripts(): PostCreateScriptRow[] {
    return this.db
      .prepare(`SELECT * FROM post_create_scripts ORDER BY name`)
      .all() as PostCreateScriptRow[];
  }

  // ---- vm_logs -------------------------------------------------------

  addLog(vmId: number | null, phase: LogPhase, output: string): void {
    this.db
      .prepare(`INSERT INTO vm_logs (vm_id, phase, output) VALUES (?, ?, ?)`)
      .run(vmId, phase, output);
  }

  listLogs(vmId: number, limit = 50): VmLogRow[] {
    return this.db
      .prepare(`SELECT * FROM vm_logs WHERE vm_id = ? ORDER BY id DESC LIMIT ?`)
      .all(vmId, limit) as VmLogRow[];
  }

  // ---- vm_snapshots -------------------------------------------------

  addSnapshot(vmId: number, snapshotName: string): void {
    this.db
      .prepare(`INSERT INTO vm_snapshots (vm_id, snapshot_name) VALUES (?, ?)`)
      .run(vmId, snapshotName);
  }

  removeSnapshot(vmId: number, snapshotName: string): void {
    this.db
      .prepare(`DELETE FROM vm_snapshots WHERE vm_id = ? AND snapshot_name = ?`)
      .run(vmId, snapshotName);
  }

  listSnapshots(vmId: number): VmSnapshotRow[] {
    return this.db
      .prepare(`SELECT * FROM vm_snapshots WHERE vm_id = ? ORDER BY id`)
      .all(vmId) as VmSnapshotRow[];
  }
}
