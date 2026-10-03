import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "./session-mcp.js";
import { capabilityDirectory } from "../../server/features/mcp/session-capability.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";

export const gitInit = (cwd, ...args) =>
  execFileSync("git", ["init", "-q", ...args, cwd], { stdio: "ignore" });

/** A running session with AgentPier tools and SSH tools in a disposable folder. */
export async function projectSession(
  t,
  f,
  { folder = "plain-project", git = false, selection = true } = {},
) {
  const cwd = path.join(f.home, folder);
  await fs.mkdir(cwd, { recursive: true });
  if (git) gitInit(cwd);
  await fs.writeFile(path.join(cwd, "report.html"), "<h1>Report</h1>");
  const account = f.application.accounts.get("local-codex");
  const id = randomUUID();
  const tooled = await f.application.sessionMcp.prepare({
    id,
    account,
    cwd,
    launch: { args: [], env: {} },
    selection,
  });
  const launch = await f.application.sshIntegration.prepare({
    id,
    account,
    cwd,
    launch: tooled,
  });
  const session = await f.application.sessions.create({
    ...launch,
    id,
    name: "Disposable rebind session",
    tool: "codex",
    accountId: account.id,
    cwd,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  const file = path.join(
    capabilityDirectory(f.dataDir, id),
    `${launch.agentpierTools.generation}.json`,
  );
  const client = await connect(t, f, { file });
  const capability = JSON.parse(await fs.readFile(capabilityFile(f.dataDir, id), "utf8"));
  const publish = (args = {}) =>
    client.callTool({
      name: "artifact_publish",
      arguments: {
        requestId: randomUUID(),
        title: "Report",
        sourcePath: "report.html",
        ...args,
      },
    });
  return {
    cwd,
    session,
    client,
    publish,
    fromId: launch.sshTools.project.projectId,
    ssh: (name, args = {}) => f.application.sshManagement.call(capability, name, args),
    record: () => f.application.sessions.metadata(id),
  };
}
export async function projectHost(f, projectId) {
  const management = f.application.sshManagement;
  const key = await management.ui("createKey", { name: "Deploy", projectId });
  const host = await management.ui("createHost", {
    name: "Deploy host",
    host: "host.invalid",
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
    projectId,
  });
  return { key, host };
}
export const changedMessage =
  "The project of this session changed. Reload the session to continue.";
export const parsed = (result) => JSON.parse(result.content[0].text);
export const auditRows = (f, action) =>
  f.application.audit.list({ action }).events.filter((row) => row.action === action);
