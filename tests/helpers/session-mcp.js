import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { capabilityDirectory } from "../../server/features/mcp/session-capability.js";

export const selection = (scopes = ["catalog:read", "runs:read"]) => ({
  scopes,
  currentProject: true,
  projectIds: [],
  accountIds: ["local-codex"],
  connectionIds: [],
});
export async function issue(
  f,
  { tool = "codex", choices = selection(), id = randomUUID() } = {},
) {
  const account = f.application.accounts.get(`local-${tool}`);
  const launch = await f.application.sessionMcp.prepare({
    id,
    account,
    cwd: f.home,
    launch: { args: [], env: {} },
    selection: choices,
  });
  const session = await f.application.sessions.create({
    ...launch,
    id,
    name: "Disposable MCP session",
    tool,
    accountId: account.id,
    cwd: f.home,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  const directory = capabilityDirectory(f.dataDir, id);
  const file = path.join(directory, `${launch.agentpierTools.generation}.json`);
  const { token } = JSON.parse(await fs.readFile(file, "utf8"));
  return { session, launch, file, token };
}
export async function connect(t, f, issued) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      new URL("../../server/features/mcp/session-stdio.js", import.meta.url).pathname,
      "--socket",
      f.application.sessionMcp.socketPath,
      "--capability",
      issued.file,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "fixture", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}
