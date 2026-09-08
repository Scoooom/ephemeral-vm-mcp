import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { gh } from "../github/gh.js";
import { logger } from "../logger.js";
import { handler, jsonResult } from "./util.js";

interface RepoView {
  name: string;
  url: string;
  sshUrl: string;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
}

export function registerGithubTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "create_github_repo",
    {
      title: "Create a GitHub repository",
      description:
        "Create a new GitHub repository under the account this host's `gh` CLI is authenticated as. " +
        "Defaults to private. Returns { name, url, ssh_url, clone_url, private, default_branch }. " +
        "The repo starts empty (no branches) until something is pushed to it.",
      inputSchema: {
        name: z.string().min(1).describe("Repository name (no owner prefix — created under the authenticated account)."),
        private: z.boolean().optional().describe("Create as private (default true). Pass false for a public repo."),
        description: z.string().optional().describe("Short repository description."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler<{ name: string; private?: boolean; description?: string }>(
      "create_github_repo",
      async ({ name, private: isPrivate = true, description }) => {
        const createArgs = ["repo", "create", name, isPrivate ? "--private" : "--public", "--clone=false"];
        if (description) createArgs.push("-d", description);
        await gh(createArgs);

        const { stdout } = await gh([
          "repo",
          "view",
          name,
          "--json",
          "name,url,sshUrl,isPrivate,defaultBranchRef",
        ]);
        const view = JSON.parse(stdout) as RepoView;

        logger.info(`created GitHub repo ${view.url} (${view.isPrivate ? "private" : "public"})`);
        return jsonResult({
          name: view.name,
          url: view.url,
          ssh_url: view.sshUrl,
          clone_url: `${view.url}.git`,
          private: view.isPrivate,
          default_branch: view.defaultBranchRef?.name ?? null,
        });
      },
      ctx,
    ),
  );
}
