export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered migrations. `openDb` runs every migration whose `version` is greater
 * than the database's current `PRAGMA user_version`, then bumps user_version.
 *
 * v1 is the schema from the implementation plan (§ Data model), plus:
 *   - vms.tags            — mirror of the container's Proxmox tags
 *   - vms.post_create_ran — one-shot guard for run_post_create_script
 *   - status value 'stopped' (documented in the CHECK-less comment)
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS vms (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        vmid            INTEGER NOT NULL,
        name            TEXT NOT NULL,
        template_id     INTEGER NOT NULL,
        clone_type      TEXT NOT NULL DEFAULT 'linked',   -- linked | full
        cores           INTEGER NOT NULL DEFAULT 1,
        memory_mb       INTEGER NOT NULL DEFAULT 512,
        node            TEXT NOT NULL,
        bridge          TEXT NOT NULL DEFAULT 'vmbr2',
        ip              TEXT,
        status          TEXT NOT NULL DEFAULT 'provisioning',
          -- provisioning | running | stopped | task_running | tearing_down | destroyed | error
        task_description TEXT,
        tags            TEXT,
        post_create_ran DATETIME,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        destroyed_at    DATETIME,
        owned_by        TEXT DEFAULT 'ephemeral-mcp'
      );

      CREATE INDEX IF NOT EXISTS idx_vms_vmid   ON vms(vmid);
      CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);

      CREATE TABLE IF NOT EXISTS post_create_scripts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT UNIQUE NOT NULL,
        script      TEXT NOT NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vm_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        vm_id       INTEGER REFERENCES vms(id),
        phase       TEXT NOT NULL,   -- post_create | claude_task | deploy | teardown | exec | clone
        output      TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_vm_logs_vm_id ON vm_logs(vm_id);

      CREATE TABLE IF NOT EXISTS vm_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        vm_id         INTEGER REFERENCES vms(id),
        snapshot_name TEXT NOT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_vm_snapshots_vm_id ON vm_snapshots(vm_id);
    `,
  },
  {
    version: 2,
    name: "web dashboard passkey credentials",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS web_credentials (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id TEXT UNIQUE NOT NULL,   -- base64url COSE credential id
        public_key    BLOB NOT NULL,          -- COSE public key bytes
        counter       INTEGER NOT NULL DEFAULT 0,
        transports    TEXT,                   -- comma-separated AuthenticatorTransport hints
        label         TEXT,                   -- user-facing name for the passkey
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at  DATETIME
      );
    `,
  },
  {
    version: 3,
    name: "app deployments",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS deployments (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        vm_id                    INTEGER NOT NULL REFERENCES vms(id),
        repo_url                 TEXT NOT NULL,
        branch                   TEXT,
        start_command            TEXT,
        service_name             TEXT,          -- systemd unit created on the container
        status                   TEXT NOT NULL DEFAULT 'deploying',  -- deploying | running | failed
        deployed_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
        tunnel_hostname          TEXT,
        last_tunnel_check_status TEXT,          -- e.g. 'healthy:200' | 'unhealthy:502' | 'unhealthy:noresponse'
        last_tunnel_check_at     DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_deployments_vm_id ON deployments(vm_id);
    `,
  },
];
