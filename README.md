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
| `src/tools/` | the 23 MCP tools |
| `src/services/` | shared guarded logic (`requireOwnedVm`, lifecycle, status) used by both the tools and the web API |
| `src/transports/` | stdio + streamable-HTTP (bearer-gated, localhost) |
| `src/web/` + `public/` | the web dashboard (see below) |
| `scripts/check-proxmox.ts` | `npm run check:proxmox` — API readiness probe |
| `scripts/smoke.ts` | `npm run smoke` — full-lifecycle end-to-end test |
| `deploy/` | systemd unit, cloudflared config, template-fix script |

## Setup

```bash
npm ci --ignore-scripts && npm run build
cp .env.example .env      # --http needs MCP_AUTH_TOKEN; the dashboard needs DASHBOARD_SESSION_SECRET
npm run check:proxmox     # must be all-green first
```

`--ignore-scripts` is deliberate: the only native dep (`better-sqlite3` 13.x)
ships a working `linux-x64` prebuilt binary in its npm tarball, so no compiler
toolchain is needed on `mcpProx`. Without the flag, npm still tries to
`node-gyp rebuild` it and fails on the missing `make`.

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

Deploy: `create_github_repo`, `deploy_app`, `check_tunnel_status`.

`clone_vm` allocates the VMID and static IP itself. Every per-container tool —
including `destroy_vm` — refuses any VMID that is not an active
`ephemeral-mcp`-owned row in the local DB, so it can never touch a production
container.

### Deploying an app

`create_github_repo(name, private?, description?)` creates a repo (private by
default) using this host's already-authenticated `gh` CLI and returns its URLs.

`deploy_app(vmid, repo_url, branch?, start_command)` clones/pulls the repo into
`/opt/apps/<name>` on an owned, running container (github.com URLs use the
container's pre-authorized `gh repo clone`), installs dependencies
(`npm ci`/`npm install`/`pip` — auto-detected), and runs `start_command` under a
`app-<name>` systemd unit. Each step lands in `vm_logs` under phase `deploy`, and
the deployment is tracked in the `deployments` table.

`check_tunnel_status(vmid, hostname?, path?, retries?, interval_seconds?)` is a
real health check: it resolves the tunnel hostname (argument → recorded
deployment → the container's `cloudflared` config), confirms `cloudflared` is
running, and probes the public hostname over HTTPS (a 5xx is unhealthy). Pass
`retries` to poll until healthy. `run_claude_task`-style workflows should poll
this before declaring a deploy complete. Per-container tunnels are set up on the
container itself (its `cloudflared` is preconfigured) — this tool only verifies.

## Web dashboard

Started alongside the HTTP transport (same process, `127.0.0.1:8789`) when
`DASHBOARD_ENABLED` is not `0`. Fronted by the same Cloudflare tunnel at
`proxweb.scooom.com`. Views:

- **Active** / **History** — containers from the local DB (history filterable by
  name and date range), with a per-container drawer showing live Proxmox status,
  drift, and the `vm_logs` entries filterable by phase.
- **Scripts** — create/edit `post_create_scripts` (writes through the same
  `Repo.upsertScript` path as `set_post_create_script`).
- Lifecycle buttons (start / stop / reboot / destroy) call the same
  `src/services/lifecycle.ts` functions the MCP tools use, so the ownership gate
  still applies.

**Auth: passkeys, trust-on-first-use.** The first visitor registers a WebAuthn
credential (saved by the browser / password manager); later visits authenticate
with it against an HMAC-signed session cookie. Because `proxweb.scooom.com` is
internet-facing, set `DASHBOARD_ENROLL_TOKEN` before exposing it so the first
registration requires that secret; registration then locks until an
authenticated session (or the token) adds another passkey.

Config: `DASHBOARD_*` in `.env` (see `.env.example`). `DASHBOARD_RP_ID` /
`DASHBOARD_ORIGIN` must match the public hostname. The dashboard refuses to
start without `DASHBOARD_SESSION_SECRET`.

## Status

Verified end-to-end against `pve2` via `npm run smoke`: clone,
configure (static IP / resources / tags), start, `exec_command`,
`run_post_create_script` (+ one-shot guard), `create_snapshot`,
`run_claude_task` (real `claude -p`), `rollback_snapshot`, `stop`, `destroy_vm`,
the ownership gate (`destroy_vm` on a production CT is refused), UPID task
polling, IP allocation, pool auto-creation, and the full deploy loop
(`create_github_repo` → `deploy_app` → `check_tunnel_status` against a
throwaway repo + quick tunnel). `SKIP_DEPLOY=1` skips that last block.

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
