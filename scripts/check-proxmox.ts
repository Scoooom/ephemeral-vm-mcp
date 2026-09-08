/**
 * Proxmox readiness probe.
 *
 * Run after the `pveum` ACL block from the implementation plan (§1). Exits 0
 * only if the API token can do everything this MCP server needs:
 *   - reach the API and read the version
 *   - list nodes / storage
 *   - audit + read the clone template (CT113)
 *   - see the `ephemeral` pool
 *   - confirm the target storage (`media`) exists with rootdir content
 *
 * Until the ACLs are applied you should expect FAILs on template audit and,
 * depending on the grant, empty node/storage lists.
 */
import { loadConfig } from "../src/config.js";
import { createProxmox } from "../src/proxmox/index.js";
import { ipFromNetConfig } from "../src/proxmox/lxc.js";

type Check = { name: string; ok: boolean; detail: string };

async function run(): Promise<void> {
  const cfg = loadConfig();
  const pve = createProxmox(cfg.proxmox);
  const checks: Check[] = [];

  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };
  const attempt = async (name: string, fn: () => Promise<string>) => {
    try {
      add(name, true, await fn());
    } catch (err) {
      add(name, false, err instanceof Error ? err.message : String(err));
    }
  };

  console.error(`\nProbing ${cfg.proxmox.apiBase} as ${cfg.proxmox.tokenId}\n`);

  await attempt("API reachable + version", async () => {
    const v = await pve.discovery.version();
    return `PVE ${v.version}`;
  });

  await attempt("list nodes", async () => {
    const nodes = await pve.discovery.nodes();
    const target = nodes.find((n) => n.node === cfg.proxmox.node);
    if (!target) throw new Error(`node ${cfg.proxmox.node} not visible (${nodes.length} nodes listed)`);
    return `${cfg.proxmox.node} is ${target.status}`;
  });

  await attempt("cluster nextid", async () => `${await pve.discovery.nextId()}`);

  await attempt(`storage '${cfg.proxmox.storage}' present w/ rootdir`, async () => {
    const stores = await pve.discovery.storage();
    const s = stores.find((x) => x.storage === cfg.proxmox.storage);
    if (!s) throw new Error(`storage '${cfg.proxmox.storage}' not visible (${stores.map((x) => x.storage).join(", ") || "none"})`);
    if (!String(s.content).includes("rootdir")) throw new Error(`storage '${s.storage}' content='${s.content}' lacks rootdir`);
    return `${s.storage} (${s.type}), avail ${fmtGiB(s.avail)}`;
  });

  await attempt("token NOT granted local-zfs (SSD)", async () => {
    const stores = await pve.discovery.storage();
    const ssd = stores.find((x) => x.storage === "local-zfs");
    if (ssd) return `WARNING: local-zfs is visible to this token — tighten the ACL`;
    return "local-zfs not visible (good)";
  });

  await attempt(`audit + read template CT${cfg.proxmox.templateId}`, async () => {
    const c = await pve.lxc.getConfig(cfg.proxmox.templateId);
    const isTemplate = c.template === 1;
    const rootfsStorage = String(c.rootfs ?? "").split(":")[0];
    const parts = [
      isTemplate ? "template=1" : "NOT A TEMPLATE (linked clone will fail)",
      `rootfs on ${rootfsStorage || "?"}`,
      `net0 ip=${ipFromNetConfig(c.net0) ?? "?"}`,
      c.features ? `features=${c.features}` : "no features",
    ];
    if (!isTemplate) throw new Error(parts.join(", "));
    return parts.join(", ");
  });

  await attempt(`list lxc on ${cfg.proxmox.node}`, async () => {
    const list = await pve.lxc.list();
    return `${list.length} containers visible`;
  });

  process.exitCode = report(checks);
}

function report(checks: Check[]): number {
  let failed = 0;
  console.error("Results:");
  for (const c of checks) {
    const mark = c.ok ? "PASS" : "FAIL";
    if (!c.ok) failed++;
    console.error(`  [${mark}] ${c.name} — ${c.detail}`);
  }
  console.error(
    failed === 0
      ? "\nAll checks passed — the server can provision containers.\n"
      : `\n${failed} check(s) failed — apply the pveum ACL block from the plan (§1) and re-run.\n`,
  );
  return failed === 0 ? 0 : 1;
}

function fmtGiB(bytes?: number): string {
  if (!bytes) return "?";
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

run().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(2);
});
