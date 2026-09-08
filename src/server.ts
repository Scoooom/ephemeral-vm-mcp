import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { registerAllTools } from "./tools/index.js";

const INSTRUCTIONS = `
Provisions ephemeral LXC containers on Proxmox (pve2), one per task.

- Discovery tools (list_templates, list_nodes, list_storage, list_active_vms,
  list_vm_history) are read-only and safe to call freely.
- clone_vm allocates the VMID and static IP itself — never pass them. It returns
  once SSH is reachable on the new container.
- exec_command / run_post_create_script / run_claude_task run over SSH as root.
  run_post_create_script is one-shot per container.
- create_snapshot before run_claude_task so a bad run can be rolled back.
- destroy_vm and every per-container tool only act on containers this server
  created; they refuse any other VMID.
`.trim();

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: "ephemeral-vm-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, logging: {} } },
  );
  registerAllTools(server, ctx);
  return server;
}
