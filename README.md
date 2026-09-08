# ephemeral-vm-mcp

An MCP server that provisions throwaway **LXC containers** on Proxmox `pve2`,
tracks their lifecycle in a local SQLite DB, and runs a one-shot post-create
script or a headless `claude -p` task on each over SSH.

Runs on the dedicated `mcpProx` container. Talks to Proxmox over the REST API
only (`https://pve2.scooom.com:8006`, token auth). Provisions containers on the
`vmbr2` / `10.10.30.0/24` subnet, rootfs always on the non-SSD `media` pool.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | creds from `/opt/.proxmox-api-info`, app env from `.env` |
| `src/db/` | `better-sqlite3`, `PRAGMA user_version` migrations, typed `Repo` |
| `src/proxmox/` | token-auth axios client, UPID task polling, `LxcApi`, `Discovery` |
| `src/net/ipalloc.ts` | transactional lowest-free-CID allocation |
| `src/ssh/exec.ts` | the single `execCommand` SSH primitive |
| `src/tools/` | the 20 MCP tools |
| `src/transports/` | stdio + streamable-HTTP (bearer-gated, localhost) |
| `scripts/check-proxmox.ts` | `npm run check:proxmox` — API readiness probe |
| `scripts/smoke.ts` | `npm run smoke` — full-lifecycle end-to-end test |
| `deploy/` | systemd unit, cloudflared config, template-fix script |

## Setup

```bash
npm ci && npm run build
cp .env.example .env      # set MCP_AUTH_TOKEN if using --http
npm run check:proxmox     # must be all-green first
```

Local (stdio) MCP client config:

```json
{ "command": "node", "args": ["/opt/ephemeral-vm-mcp/dist/index.js"] }
```

HTTP transport: `node dist/index.js --http` (see `deploy/`).

## Tools

Discovery: `list_templates`, `list_nodes`, `list_storage`, `list_active_vms`,
`list_vm_history`, `get_vm_status`, `get_vm_ip`, `list_snapshots`,
`list_post_create_scripts`.

Mutating: `clone_vm`, `start_vm`, `stop_vm`, `reboot_vm`, `destroy_vm`,
`exec_command`, `set_post_create_script`, `run_post_create_script`,
`run_claude_task`, `create_snapshot`, `rollback_snapshot`.

`clone_vm` allocates the VMID and static IP itself. Every per-container tool —
including `destroy_vm` — refuses any VMID that is not an active
`ephemeral-mcp`-owned row in the local DB, so it can never touch a production
container.

## Status

Verified end-to-end against `pve2` (18/18 `npm run smoke` checks): clone,
configure (static IP / resources / tags), start, `exec_command`,
`run_post_create_script` (+ one-shot guard), `create_snapshot`,
`run_claude_task` (real `claude -p`), `rollback_snapshot`, `stop`, `destroy_vm`,
the ownership gate (`destroy_vm` on a production CT is refused), UPID task
polling, IP allocation, pool auto-creation.

### CT113 template fixes applied during bring-up

The template needed two fixes for cloned containers to be SSH-reachable (done
2026-09-08; a `media/basevol-113-disk-0@safety-pre-sshfix` ZFS snapshot was
taken first):

1. `firstboot-regen.service` is now ordered `Before=ssh.service ssh.socket`
   (was `Before=ssh.service` only, so `ssh.socket` could bind :22 and trigger a
   keyless `sshd` that hit the restart limit and gave up).
2. Its script no longer calls `systemctl restart ssh.*` (that deadlocked against
   its own `Before=` ordering). Ordering alone is sufficient.

`run_claude_task` runs `claude -p` as root with `IS_SANDBOX=1` (Claude Code
refuses `bypassPermissions` as root without it).
