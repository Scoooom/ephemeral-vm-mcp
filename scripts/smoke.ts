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
 *   npm run smoke              # full run, destroys the CT at the end
 *   KEEP=1 npm run smoke       # leave the CT running for inspection
 *   SKIP_CLAUDE=1 npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEEP = process.env.KEEP === "1";
const SKIP_CLAUDE = process.env.SKIP_CLAUDE === "1";

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
  try {
    const tools = await client.listTools();
    check("tools/list returns 20 tools", tools.tools.length === 20, `${tools.tools.length}`);

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
    await call("exec_command", { vmid, cmd: "echo dirty > /tmp/dirty.marker" });

    if (!SKIP_CLAUDE) {
      console.log("\nrun_claude_task (may take a minute)...");
      const ct = await call("run_claude_task", { vmid, prompt: "Print exactly the text CLAUDE_OK and nothing else.", max_turns: 2 });
      const ctOut = JSON.parse(textOf(ct)) as { code: number | null; stdout: string; stderr: string };
      check("run_claude_task exit 0", ctOut.code === 0, `stderr: ${ctOut.stderr.slice(0, 200)}`);
      check("run_claude_task mentions CLAUDE_OK", ctOut.stdout.includes("CLAUDE_OK"), ctOut.stdout.slice(0, 200));
    }

    const rb = await call("rollback_snapshot", { vmid, snapshot_name: "pretask" });
    check("rollback_snapshot ok", !rb.isError, textOf(rb));
    const dirty = await call("exec_command", { vmid, cmd: "cat /tmp/dirty.marker 2>&1 || echo GONE" });
    check("rollback removed post-snapshot file", JSON.parse(textOf(dirty)).stdout.trim() === "GONE");

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
    await client.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
