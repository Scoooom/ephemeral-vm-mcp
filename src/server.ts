import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { registerAllTools } from "./tools/index.js";

const INSTRUCTIONS = `
Provisions ephemeral LXC containers on Proxmox (pve2), one per task.

- Discovery tools (list_templates, list_nodes, list_storage, list_active_vms,
  list_vm_history) are read-only and safe to call freely.
- clone_vm allocates the VMID and static IP itself — never pass them. It returns
  once SSH is reachable on the new container.
- exec_command / run_post_create_script run over SSH as root.
  run_post_create_script is one-shot per container.
- run_claude_task launches Claude Code as a detached, Remote-Control-enabled
  tmux session and returns immediately with a session_url (open it to watch or
  steer the run live). Poll get_claude_task_status until it is no longer
  'running' — completion is signalled by a sentinel file the task writes — and
  check_tunnel_status before calling a deploy done. It self-kills on a timeout.
- create_snapshot before run_claude_task so a bad run can be rolled back.
- destroy_vm and every per-container tool only act on containers this server
  created; they refuse any other VMID.
- create_github_repo makes a new (private by default) GitHub repo via this
  host's authenticated gh CLI. deploy_app clones/pulls a repo onto a container
  and runs it under a systemd unit. check_tunnel_status health-checks a
  deployed container's Cloudflare tunnel — poll it (retries=N) until healthy
  before declaring a deploy done.
`.trim();

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: "ephemeral-vm-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, logging: {} } },
  );
  registerAllTools(server, ctx);
  return server;
}
