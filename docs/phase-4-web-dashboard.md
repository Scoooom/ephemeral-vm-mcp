# Phase 4 handoff — Web dashboard

Status: **shipped and live** (2026-09-08). `master` @ `b394b72`. Deployed on
`mcpProx`, running under `ephemeral-vm-mcp.service`.

## What was built

A human-facing web dashboard served from the **same process** as the MCP HTTP
transport, on `127.0.0.1:8789`, fronted by the existing Cloudflare tunnel at a
second hostname **`proxweb.scooom.com`**.

| View | Backed by |
|---|---|
| **Active** — name, VMID, IP, status, task, age, tags | `Repo.listActive()` + `created_at`-derived age |
| **History** — same + created/destroyed, filter by name & date range | `Repo.listHistory({name,from,to})` |
| Per-container **drawer** — live Proxmox status + drift, resources, timestamps | `services/status.ts` `vmStatusWithDrift()` |
| **Log viewer** in the drawer — `vm_logs`, filterable by phase | `Repo.listLogs(vmRowId, {phase,order})` |
| **Scripts** tab — create/edit `post_create_scripts` | `Repo.upsertScript()` (same path as `set_post_create_script`) |
| Lifecycle buttons — start / stop / reboot / destroy | `services/lifecycle.ts` (carries the `requireOwnedVm` gate) |

### Design decisions (deviations from the original phase-4 brief)

- **Exposed via the tunnel, not VPN-only.** `proxweb.scooom.com` is a second
  ingress on the `ephemeral-vm-mcp` tunnel → `127.0.0.1:8789`.
- **Full lifecycle controls** are exposed (not just read views).
- **Auth is WebAuthn passkeys, trust-on-first-use** (not "no auth needed").
  First visitor registers a passkey; `DASHBOARD_ENROLL_TOKEN` gates that first
  registration. Sessions are HMAC-signed cookies (no dependency, constant-time
  verify, same style as the MCP bearer check). One passkey is currently
  registered.
- **Cloudflare Access is NOT in front of `proxweb`** — the app's passkey auth is
  the only gate. (Owner may add an Access policy later; noted as optional.)

## Architecture

```
src/services/        NEW — guarded logic shared by MCP tools AND the web API
  ownership.ts        ToolError + requireOwnedVm  (moved out of tools/util.ts,
                      re-exported from there so tool call sites are unchanged)
  lifecycle.ts        startVm / stopVm / rebootVm / destroyVm (ctx, vmid)
  status.ts           vmStatusWithDrift(ctx, vmid)
src/web/             NEW
  session.ts          signed session + WebAuthn-challenge cookies, cookie parse
  auth.ts             @simplewebauthn/server register/login, requireSession mw
  api.ts              /api/vms, /api/history, /api/vms/:vmid(+/logs),
                      /api/scripts (GET/PUT), /api/vms/:vmid/{start,stop,reboot,destroy}
  dashboard.ts        startDashboard(ctx) — 2nd Express listener, localhost
public/              NEW — static, no build step
  login.html/js       passkey ceremony (vendored @simplewebauthn/browser UMD)
  index.html/app.js/styles.css   the three tabs + drawer
src/index.ts          starts startDashboard(ctx) after startHttp when
                      DASHBOARD_ENABLED != 0 and useHttp
src/db/migrations.ts  migration v2 → web_credentials table
src/db/repo.ts        listHistory, listLogs(opts), web-credential CRUD
```

The MCP tools were **refactored to thin wrappers** over `src/services/` — no
behaviour change; tool names/schemas/result strings identical. `npm run smoke`
passes **18/18** on the merged `master`.

## Config (all in `/opt/ephemeral-vm-mcp/.env`, documented in `.env.example`)

| var | live value | notes |
|---|---|---|
| `DASHBOARD_ENABLED` | `1` | set `0` to run the MCP transport without the dashboard |
| `DASHBOARD_PORT` / `DASHBOARD_HOST` | `8789` / `127.0.0.1` | tunnel is the only ingress |
| `DASHBOARD_RP_ID` | `proxweb.scooom.com` | WebAuthn RP ID — must equal the public host |
| `DASHBOARD_ORIGIN` | `https://proxweb.scooom.com` | WebAuthn origin — used as a constant, not from `req` (tunnel forwards plain HTTP) |
| `DASHBOARD_SESSION_SECRET` | *(64-char random, generated)* | dashboard refuses to start if unset |
| `DASHBOARD_ENROLL_TOKEN` | *(48-hex random, generated)* | required to register the first / any new passkey until a session exists |

`.env` backup: `/root/ephemeral-vm-mcp-backups/.env.bak.*`.

## Infra changes made on `mcpProx`

- **Cloudflare:** `cloudflared tunnel route dns ephemeral-vm-mcp
  proxweb.scooom.com`; added the `proxweb → 127.0.0.1:8789` ingress rule to
  `/etc/cloudflared/config.yml` (backup: `config.yml.bak.*`); restarted
  `cloudflared`. Committed equivalent in `deploy/cloudflared-config.example.yml`
  and `deploy/setup-tunnel.sh`.
- **Logging:** journald has no working storage in this unprivileged LXC, so a
  systemd drop-in (`/etc/systemd/system/ephemeral-vm-mcp.service.d/10-logs.conf`)
  sends stdout/stderr to `/var/log/ephemeral-vm-mcp.log`, rotated weekly by
  `/etc/logrotate.d/ephemeral-vm-mcp`. Both captured in `deploy/`.
- **DB:** migration v2 already applied to the live `data/ephemeral.db`
  (`user_version=2`, `web_credentials` table).

## Deploy / redeploy procedure

```bash
cd /opt/ephemeral-vm-mcp
git pull
npm ci --ignore-scripts && npm run build   # --ignore-scripts is REQUIRED:
                                           # mcpProx has no C toolchain;
                                           # better-sqlite3 13.x ships a prebuilt .node
systemctl restart ephemeral-vm-mcp
```

Fresh host also needs the two `deploy/` install steps for the tunnel ingress and
the logging drop-in (see file headers).

## Verified

- `npm run typecheck`, `npm run build`, `npm run smoke` (18/18) on `master`.
- Through the tunnel: `proxweb.scooom.com` healthz, `/` → login redirect,
  static assets, `/api/*` → 401 unauthenticated, passkey **registration
  completed** (`enrolled: true`), ownership gate returns 409 on a production
  VMID. `mcpprox.scooom.com` MCP endpoint unaffected.

## Known follow-ups / gotchas

- **Never run a bare `npm ci` / `npm install`** in this repo on `mcpProx` — it
  wipes `node_modules` and then fails building `better-sqlite3` (no `make`).
  Always `--ignore-scripts`. (An incident during deploy did exactly this; it was
  recovered, current install is verified good.)
- The owner's failed first registration attempts may have left **orphan passkeys**
  for `proxweb.scooom.com` in the password manager (created client-side, never
  saved server-side). Harmless — the server only accepts the one it stored — but
  worth cleaning up in the manager.
- Adding **more** passkeys requires an authenticated session (or the enroll
  token); there is no UI for it yet — hit `POST /api/auth/register/options` +
  `/verify` while logged in.
- No **Cloudflare Access** on `proxweb`; if desired, add an interactive (not
  service-token) Access policy for that hostname.
- Lifecycle POSTs block until the Proxmox task finishes (up to ~5 min for
  destroy); the UI disables the buttons and toasts on completion, but there is
  no progress streaming.
- `vm_logs` viewer caps at 500 entries per container.
