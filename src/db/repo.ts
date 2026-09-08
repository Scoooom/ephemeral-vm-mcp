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

export type DeploymentStatus = "deploying" | "running" | "failed";

export interface DeploymentRow {
  id: number;
  vm_id: number;
  repo_url: string;
  branch: string | null;
  start_command: string | null;
  service_name: string | null;
  status: DeploymentStatus;
  deployed_at: string;
  tunnel_hostname: string | null;
  last_tunnel_check_status: string | null;
  last_tunnel_check_at: string | null;
}

export interface WebCredentialRow {
  id: number;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
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

  /**
   * History rows, newest first, optionally narrowed by a name substring and/or
   * a `created_at` range (inclusive; `YYYY-MM-DD` or full timestamps).
   */
  listHistory(opts: { name?: string; from?: string; to?: string } = {}): VmRow[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (opts.name) {
      where.push(`name LIKE @name`);
      params.name = `%${opts.name}%`;
    }
    if (opts.from) {
      where.push(`created_at >= @from`);
      params.from = opts.from;
    }
    if (opts.to) {
      where.push(`created_at <= @to`);
      params.to = opts.to;
    }
    const sql =
      `SELECT * FROM vms` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : ``) +
      ` ORDER BY id DESC`;
    const stmt = this.db.prepare(sql);
    return (where.length ? stmt.all(params) : stmt.all()) as VmRow[];
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

  /**
   * Logs for one container row (`vms.id`), optionally filtered by phase.
   * Defaults to chronological order so the dashboard log viewer reads top-down.
   */
  listLogs(
    vmId: number,
    opts: { phase?: LogPhase; limit?: number; order?: "asc" | "desc" } = {},
  ): VmLogRow[] {
    const { phase, limit = 200, order = "asc" } = opts;
    const sql =
      `SELECT * FROM vm_logs WHERE vm_id = @vmId` +
      (phase ? ` AND phase = @phase` : ``) +
      ` ORDER BY id ${order === "desc" ? "DESC" : "ASC"} LIMIT @limit`;
    const params: Record<string, unknown> = { vmId, limit };
    if (phase) params.phase = phase;
    return this.db.prepare(sql).all(params) as VmLogRow[];
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

  // ---- deployments -------------------------------------------------

  insertDeployment(input: {
    vmId: number;
    repoUrl: string;
    branch: string | null;
    startCommand: string | null;
  }): DeploymentRow {
    const info = this.db
      .prepare(
        `INSERT INTO deployments (vm_id, repo_url, branch, start_command)
         VALUES (@vmId, @repoUrl, @branch, @startCommand)`,
      )
      .run(input as unknown as Record<string, unknown>);
    return this.db
      .prepare(`SELECT * FROM deployments WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as DeploymentRow;
  }

  finishDeployment(id: number, status: "running" | "failed", serviceName: string | null): void {
    this.db
      .prepare(`UPDATE deployments SET status = ?, service_name = ? WHERE id = ?`)
      .run(status, serviceName, id);
  }

  latestDeployment(vmId: number): DeploymentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM deployments WHERE vm_id = ? ORDER BY id DESC LIMIT 1`)
      .get(vmId) as DeploymentRow | undefined;
  }

  /**
   * Record the outcome of a tunnel health check on a deployment. `hostname` is
   * only overwritten when a non-null value is supplied (a check by explicit
   * hostname shouldn't wipe a discovered one, and vice versa).
   */
  recordTunnelCheck(id: number, hostname: string | null, status: string): void {
    this.db
      .prepare(
        `UPDATE deployments
            SET tunnel_hostname = COALESCE(?, tunnel_hostname),
                last_tunnel_check_status = ?,
                last_tunnel_check_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(hostname, status, id);
  }

  // ---- web_credentials (dashboard passkey auth) --------------------

  countCredentials(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM web_credentials`).get() as { n: number }
    ).n;
  }

  listCredentials(): WebCredentialRow[] {
    return this.db
      .prepare(`SELECT * FROM web_credentials ORDER BY id`)
      .all() as WebCredentialRow[];
  }

  getCredentialByCredId(credentialId: string): WebCredentialRow | undefined {
    return this.db
      .prepare(`SELECT * FROM web_credentials WHERE credential_id = ?`)
      .get(credentialId) as WebCredentialRow | undefined;
  }

  addCredential(input: {
    credentialId: string;
    publicKey: Buffer;
    counter: number;
    transports?: string | null;
    label?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO web_credentials (credential_id, public_key, counter, transports, label)
         VALUES (@credentialId, @publicKey, @counter, @transports, @label)`,
      )
      .run({
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: input.counter,
        transports: input.transports ?? null,
        label: input.label ?? null,
      });
  }

  bumpCredential(credentialId: string, counter: number): void {
    this.db
      .prepare(
        `UPDATE web_credentials
            SET counter = ?, last_used_at = CURRENT_TIMESTAMP
          WHERE credential_id = ?`,
      )
      .run(counter, credentialId);
  }
}
