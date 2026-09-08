/**
 * End-to-end smoke test.
 *
 * Drives the built server as an MCP stdio client through the full lifecycle:
 *   list_templates -> clone_vm -> get_vm_status -> exec_command
 *   -> set/run post_create_script -> create_snapshot -> run_claude_task
 *   -> rollback_snapshot -> destroy_vm
 * and asserts destroy_vm refuses a production VMID (CT100).
 *
 * Requires: `npm run build` first, a reachable Proxmox with the token ACLs in
 * place, and SSH from this host into the ephemeral subnet.
 *
 *   npm run smoke              # full run, destroys the CT + throwaway repo at the end
 *   KEEP=1 npm run smoke       # leave the CT running for inspection
 *   SKIP_CLAUDE=1 npm run smoke
 *   SKIP_DEPLOY=1 npm run smoke   # skip create_github_repo / deploy_app / check_tunnel_status
 *
 * The deploy block additionally needs an authenticated `gh` CLI on this host
 * (with `delete_repo` scope for clean teardown), a container image with `git`
 * and outbound HTTPS (deploy_app bootstraps Node if the image lacks it), and a
 * reachable `proxweb.scooom.com` for the positive tunnel-probe check.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEEP = process.env.KEEP === "1";
const SKIP_CLAUDE = process.env.SKIP_CLAUDE === "1";
const SKIP_DEPLOY = process.env.SKIP_DEPLOY === "1";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<ToolResult> => {
    return (await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs, resetTimeoutOnProgress: true },
    )) as ToolResult;
  };

  let vmid = 0;
  let ip = "";
  let ghRepo = ""; // "owner/name" of the throwaway repo, for teardown
  try {
    const tools = await client.listTools();
    check("tools/list returns 23 tools", tools.tools.length === 23, `${tools.tools.length}`);

    const tpl = await call("list_templates");
    check("list_templates has CT113", textOf(tpl).includes('"vmid": 113'));

    console.log("\nclone_vm (this takes ~30-60s)...");
    const cloned = await call(
      "clone_vm",
      { name: `smoke-${Date.now().toString().slice(-6)}`, task_description: "automated smoke test" },
      600_000,
    );
    check("clone_vm ok", !cloned.isError, textOf(cloned).slice(0, 200));
    if (cloned.isError) throw new Error("clone failed, aborting");
    const info = JSON.parse(textOf(cloned)) as { vmid: number; ip: string; status: string };
    vmid = info.vmid;
    ip = info.ip;
    check("clone_vm returned running + ip", info.status === "running" && !!info.ip, `vmid=${vmid} ip=${ip}`);

    const status = await call("get_vm_status", { vmid });
    check("get_vm_status: no drift", JSON.parse(textOf(status)).drift.length === 0);

    const active = await call("list_active_vms");
    check("list_active_vms includes the new CT", textOf(active).includes(`"vmid": ${vmid}`));

    const hn = await call("exec_command", { vmid, cmd: "hostname && id -un && ip -4 -o addr show eth0 | awk '{print $4}'" });
    const hnOut = JSON.parse(textOf(hn)) as { code: number; stdout: string };
    check("exec_command hostname/ip", hnOut.code === 0 && hnOut.stdout.includes(ip), hnOut.stdout.trim().replace(/\n/g, " | "));

    await call("set_post_create_script", { name: "smoke-noop", script: "#!/bin/bash\nset -e\necho post-create-ran > /tmp/pcs.marker\necho ok" });
    const pcs = await call("run_post_create_script", { vmid, script_name: "smoke-noop" });
    check("run_post_create_script ok", JSON.parse(textOf(pcs)).code === 0);
    const pcs2 = await call("run_post_create_script", { vmid, script_name: "smoke-noop" });
    check("run_post_create_script refuses 2nd run", pcs2.isError === true);

    const snap = await call("create_snapshot", { vmid, snapshot_name: "pretask" });
    check("create_snapshot ok", !snap.isError, textOf(snap));
    await call("exec_command", { vmid, cmd: "echo dirty > /root/dirty.marker && sync" });
    const preRb = await call("exec_command", { vmid, cmd: "cat /root/dirty.marker 2>&1 || echo MISSING" });
    check("dirty marker written pre-rollback", JSON.parse(textOf(preRb)).stdout.trim() === "dirty");

    if (!SKIP_CLAUDE) {
      console.log("\nrun_claude_task (may take a minute)...");
      const ct = await call("run_claude_task", { vmid, prompt: "Print exactly the text CLAUDE_OK and nothing else.", max_turns: 2 });
      const ctOut = JSON.parse(textOf(ct)) as { code: number | null; stdout: string; stderr: string };
      check("run_claude_task exit 0", ctOut.code === 0, `stderr: ${ctOut.stderr.slice(0, 200)}`);
      check("run_claude_task mentions CLAUDE_OK", ctOut.stdout.includes("CLAUDE_OK"), ctOut.stdout.slice(0, 200));
    }

    const rb = await call("rollback_snapshot", { vmid, snapshot_name: "pretask" });
    check("rollback_snapshot ok", !rb.isError, textOf(rb));
    const dirty = await call("exec_command", { vmid, cmd: "test -e /root/dirty.marker && echo PRESENT || echo GONE" });
    const dOut = JSON.parse(textOf(dirty)).stdout.trim();
    check("rollback removed post-snapshot file", dOut === "GONE", dOut);

    if (!SKIP_DEPLOY) {
      console.log("\ndeploy loop: create_github_repo → deploy_app → check_tunnel_status ...");
      const repoName = `smoke-deploy-${Date.now().toString().slice(-9)}`;
      const created = await call("create_github_repo", { name: repoName, private: true, description: "ephemeral-vm-mcp smoke test — safe to delete" });
      check("create_github_repo ok", !created.isError, textOf(created).slice(0, 200));
      const repo = JSON.parse(textOf(created)) as { url: string; clone_url: string; name: string };
      check("create_github_repo returned a github.com URL", /^https:\/\/github\.com\//.test(repo.url), repo.url);
      const owner = repo.url.split("/")[3];
      ghRepo = `${owner}/${repo.name}`;

      // Push a tiny fixture app to the fresh repo (uses gh as the git credential helper).
      const work = mkdtempSync(join(tmpdir(), "smoke-deploy-"));
      try {
        writeFileSync(join(work, "server.js"),
          'const http=require("http");const p=process.env.PORT||8080;' +
          'http.createServer((_q,r)=>r.end("SMOKE_APP_OK")).listen(p,()=>console.log("up on "+p));\n');
        writeFileSync(join(work, "package.json"),
          JSON.stringify({ name: "smoke-deploy-app", version: "1.0.0", private: true }, null, 2) + "\n");
        const git = (...a: string[]) => execFileSync("git", a, { cwd: work, stdio: "pipe" });
        git("init", "-b", "main");
        git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "add", "-A");
        git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-m", "smoke fixture app");
        git("remote", "add", "origin", repo.clone_url);
        git("-c", "credential.helper=!gh auth git-credential", "push", "-u", "origin", "main");
        check("pushed fixture app to the new repo", true, repo.clone_url);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }

      console.log("deploy_app (clone + Node bootstrap + npm + systemd, ~1-3 min)...");
      const deployed = await call("deploy_app",
        { vmid, repo_url: repo.clone_url, branch: "main", start_command: "node server.js" }, 600_000);
      const dOut = JSON.parse(textOf(deployed)) as { deployed: boolean; service_name: string; stdout: string; stderr: string };
      check("deploy_app deployed=true", dOut.deployed === true, `${dOut.service_name}: ${(dOut.stderr || dOut.stdout).slice(-200)}`);

      const appCurl = await call("exec_command", { vmid, cmd: "curl -fsS --max-time 5 http://localhost:8080" });
      check("deployed app answers on :8080", JSON.parse(textOf(appCurl)).stdout.includes("SMOKE_APP_OK"), JSON.parse(textOf(appCurl)).stdout.slice(0, 120));

      // check_tunnel_status: no tunnel is configured on the smoke container, so
      // the check must report *unhealthy* — proving it really probes rather than
      // assuming success once deploy_app returned.
      const noTun = await call("check_tunnel_status", { vmid }, 60_000);
      const nOut = JSON.parse(textOf(noTun)) as { healthy: boolean; http_status: number | null; cloudflared_active: boolean };
      check("check_tunnel_status reports unhealthy when there is no tunnel",
        nOut.healthy === false && nOut.http_status === null && nOut.cloudflared_active === false, JSON.stringify(nOut));

      // Positive path: probe a real, live Cloudflare tunnel (this host's own
      // dashboard hostname) to exercise the HTTPS probe + deployment-row update.
      const tun = await call("check_tunnel_status", { vmid, hostname: "proxweb.scooom.com", retries: 3, interval_seconds: 5 }, 60_000);
      const tOut = JSON.parse(textOf(tun)) as { healthy: boolean; http_status: number | null; hostname: string };
      check("check_tunnel_status healthy against a live Cloudflare tunnel",
        tOut.healthy === true && typeof tOut.http_status === "number", JSON.stringify(tOut));

      const withDep = await call("get_vm_status", { vmid });
      const depRow = JSON.parse(textOf(withDep)).deployment as
        { repo_url: string; tunnel_hostname: string | null; last_tunnel_check_status: string | null } | null;
      check("get_vm_status surfaces the deployment + last tunnel check",
        !!depRow && depRow.repo_url === repo.clone_url
          && depRow.tunnel_hostname === "proxweb.scooom.com"
          && (depRow.last_tunnel_check_status ?? "").startsWith("healthy"),
        JSON.stringify(depRow));
    }

    const guard = await call("destroy_vm", { vmid: 100 });
    check("destroy_vm(100) refused (ownership gate)", guard.isError === true, textOf(guard).slice(0, 120));
  } finally {
    if (vmid && !KEEP) {
      console.log(`\ndestroy_vm(${vmid})...`);
      const d = await call("destroy_vm", { vmid });
      check("destroy_vm ok", !d.isError, textOf(d));
      const hist = await call("list_vm_history");
      check("history shows destroyed", textOf(hist).includes(`"vmid": ${vmid}`) && textOf(hist).includes('"status": "destroyed"'));
    } else if (vmid) {
      console.log(`\nKEEP=1 — leaving CT ${vmid} (${ip}) running.`);
    }

    if (ghRepo && !KEEP) {
      try {
        execFileSync("gh", ["repo", "delete", ghRepo, "--yes"], { stdio: "pipe" });
        check("throwaway github repo deleted", true, ghRepo);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        check("throwaway github repo cleanup", true,
          `NOT deleted — run \`gh repo delete ${ghRepo} --yes\` manually (needs delete_repo scope). ${msg.slice(0, 120)}`);
      }
    } else if (ghRepo) {
      console.log(`\nKEEP=1 — leaving repo ${ghRepo}.`);
    }

    await client.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
