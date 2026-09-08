import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { registerDiscoveryTools } from "./discovery.js";
import { registerInventoryTools } from "./inventory.js";
import { registerLifecycleTools } from "./lifecycle.js";
import { registerSnapshotTools } from "./snapshots.js";
import { registerScriptTools } from "./scripts.js";
import { registerExecTools } from "./exec.js";
import { registerClaudeTools } from "./claude.js";
import { registerGithubTools } from "./github.js";
import { registerDeployTools } from "./deploy.js";

export function registerAllTools(server: McpServer, ctx: AppContext): void {
  registerDiscoveryTools(server, ctx);
  registerInventoryTools(server, ctx);
  registerScriptTools(server, ctx);
  registerLifecycleTools(server, ctx);
  registerSnapshotTools(server, ctx);
  registerExecTools(server, ctx);
  registerClaudeTools(server, ctx);
  registerGithubTools(server, ctx);
  registerDeployTools(server, ctx);
}
