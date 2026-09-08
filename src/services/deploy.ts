import type { AppContext } from "../context.js";
import { execCommand, shellQuote } from "../ssh/exec.js";
import { requireOwnedVm } from "./ownership.js";
import { resolveContainerHost } from "./remote.js";

export interface DeployInput {
  vmid: number;
  repoUrl: string;
  branch?: string;
  startCommand: string;
}

export interface DeployResult {
  vmid: number;
  repo_url: string;
  branch: string;
  service_name: string;
  app_dir: string;
  deployed: boolean;
  code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 8_000;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `…[${text.length - MAX_OUTPUT} chars truncated — full output in vm_logs]\n` + text.slice(-MAX_OUTPUT);
}

/** Lowercase, filesystem-safe app name derived from the repo URL's last segment. */
export function deriveAppName(repoUrl: string): string {
  const last = repoUrl.replace(/\/+$/, "").split(/[/:]/).pop() ?? "app";
  const name = last
    .replace(/\.git$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return name || "app";
}

/** `owner/repo` for a github.com URL, else null (use plain `git clone`). */
export function githubSlug(repoUrl: string): string | null {
  const m = repoUrl.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : null;
}

/**
 * Deploy an app from a git repo onto an existing, running, owned container:
 * clone/pull, install dependencies, run it under a systemd unit. Built on the
 * single `execCommand` SSH primitive (script transferred as base64, same as
 * `run_post_create_script`). A non-zero exit is a normal result, not a throw.
 */
export async function deployApp(ctx: AppContext, input: DeployInput): Promise<DeployResult> {
  const branch = input.branch?.trim() || "main";
  const row = requireOwnedVm(ctx, input.vmid);
  const host = await resolveContainerHost(ctx, row, input.vmid);

  const appName = deriveAppName(input.repoUrl);
  const appDir = `/opt/apps/${appName}`;
  const serviceName = `app-${appName}`;
  const slug = githubSlug(input.repoUrl) ?? "";

  const deployment = ctx.repo.insertDeployment({
    vmId: row.id,
    repoUrl: input.repoUrl,
    branch,
    startCommand: input.startCommand,
  });

  const script = buildDeployScript();
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const cmd = `echo ${shellQuote(b64)} | base64 -d > /tmp/deploy-app.sh && bash /tmp/deploy-app.sh`;

  ctx.repo.setStatus(row.id, "task_running");
  try {
    const result = await execCommand({
      host,
      cmd,
      timeoutMs: 600_000,
      user: ctx.cfg.ssh.user,
      privateKey: ctx.cfg.ssh.privateKey,
      env: {
        REPO_URL: input.repoUrl,
        REPO_SLUG: slug,
        BRANCH: branch,
        START_COMMAND: input.startCommand,
        APP_NAME: appName,
        APP_DIR: appDir,
        SERVICE_NAME: serviceName,
      },
    });

    const deployed = result.code === 0 && !result.timedOut && /^IS_ACTIVE=active$/m.test(result.stdout);
    ctx.repo.finishDeployment(deployment.id, deployed ? "running" : "failed", serviceName);
    ctx.repo.addLog(
      row.id,
      "deploy",
      `deploy ${input.repoUrl}@${branch} → ${serviceName} (${appDir})\n` +
        `[exit ${result.code}${result.timedOut ? " TIMED OUT" : ""}] deployed=${deployed}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );

    return {
      vmid: input.vmid,
      repo_url: input.repoUrl,
      branch,
      service_name: serviceName,
      app_dir: appDir,
      deployed,
      code: result.code,
      timed_out: result.timedOut,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
    };
  } finally {
    ctx.repo.setStatus(row.id, "running");
  }
}

function buildDeployScript(): string {
  return /* bash */ `#!/bin/bash
set -uo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true

ensure_node() {
  command -v node >/dev/null 2>&1 && return 0
  echo "[deploy] no node runtime found — installing latest Node v22 to /opt/node"
  case "$(uname -m)" in
    x86_64|amd64) NARCH=x64 ;;
    aarch64|arm64) NARCH=arm64 ;;
    *) NARCH=x64 ;;
  esac
  mkdir -p /opt/node
  local tarball
  tarball=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE "node-v22\\.[0-9.]+-linux-\${NARCH}\\.tar\\.xz" | head -n1)
  [ -n "$tarball" ] || { echo "[deploy] could not resolve a Node tarball name" >&2; return 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/\${tarball}" | tar -xJ -C /opt/node --strip-components=1
  export PATH="/opt/node/bin:$PATH"
  echo "[deploy] installed node $(node -v) / npm $(npm -v)"
}

deploy() {
  set -e
  mkdir -p /opt/apps

  if [ -d "$APP_DIR/.git" ]; then
    echo "[deploy] updating existing checkout at $APP_DIR"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  else
    rm -rf "$APP_DIR"
    if [ -n "$REPO_SLUG" ]; then
      echo "[deploy] gh repo clone $REPO_SLUG ($BRANCH)"
      gh repo clone "$REPO_SLUG" "$APP_DIR" -- --branch "$BRANCH" --depth 1
    else
      echo "[deploy] git clone $REPO_URL ($BRANCH)"
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    fi
  fi

  cd "$APP_DIR"

  if [ -f package.json ] || [ -f package-lock.json ] || echo "$START_COMMAND" | grep -qwE 'node|npm|npx'; then
    ensure_node
  fi

  if [ -f package-lock.json ]; then
    echo "[deploy] npm ci"
    npm ci --omit=dev
  elif [ -f package.json ]; then
    echo "[deploy] npm install"
    npm install --omit=dev
  elif [ -f requirements.txt ]; then
    echo "[deploy] pip install -r requirements.txt"
    (pip3 install --quiet -r requirements.txt \\
      || pip install --quiet -r requirements.txt \\
      || python3 -m pip install --quiet -r requirements.txt)
  else
    echo "[deploy] no recognised dependency manifest — skipping install"
  fi

  NODE_BIN="$(command -v node >/dev/null 2>&1 && dirname "$(command -v node)" || true)"
  if [ -n "$NODE_BIN" ]; then
    RUNPATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  else
    RUNPATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  fi

  cat > "$APP_DIR/.deploy-run.sh" <<RUNSCRIPT
#!/bin/bash
set -e
export PATH="$RUNPATH"
cd "$APP_DIR"
exec $START_COMMAND
RUNSCRIPT
  chmod +x "$APP_DIR/.deploy-run.sh"

  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=deployed app $APP_NAME
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PATH=$RUNPATH
Environment=NODE_ENV=production
ExecStart=$APP_DIR/.deploy-run.sh
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 3
}

RC=0
deploy || RC=$?

echo "IS_ACTIVE=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
echo "--- systemctl status ---"
systemctl --no-pager --full status "$SERVICE_NAME" 2>&1 | head -n 20 || true
echo "--- journal (last 40) ---"
journalctl -u "$SERVICE_NAME" --no-pager -n 40 2>&1 || true
exit $RC
`;
}
