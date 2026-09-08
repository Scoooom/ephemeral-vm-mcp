import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { handler, textResult } from "./util.js";

export function registerScriptTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "set_post_create_script",
    {
      title: "Save a post-create script",
      description:
        "Create or replace a named post-create script. run_post_create_script runs one of these " +
        "(once per container). The script body is executed with bash on the container as root.",
      inputSchema: {
        name: z.string().min(1).describe("Script name (used by run_post_create_script)."),
        script: z.string().min(1).describe("Script body, e.g. starting with #!/bin/bash."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    handler<{ name: string; script: string }>(
      "set_post_create_script",
      async ({ name, script }) => {
        const row = ctx.repo.upsertScript(name, script);
        return textResult(`Saved post-create script '${row.name}' (${script.length} bytes, updated ${row.updated_at}).`);
      },
      ctx,
    ),
  );

  server.registerTool(
    "list_post_create_scripts",
    {
      title: "List post-create scripts",
      description: "Names and sizes of saved post-create scripts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler("list_post_create_scripts", async () => {
      const rows = ctx.repo.listScripts();
      return textResult(
        rows.length
          ? rows.map((r) => `- ${r.name} (${r.script.length} bytes, updated ${r.updated_at})`).join("\n")
          : "No post-create scripts saved.",
      );
    }, ctx),
  );
}
