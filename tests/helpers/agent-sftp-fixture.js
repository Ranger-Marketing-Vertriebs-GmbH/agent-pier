import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { agentSshFixture, sftpHostId, sftpRow } from "./agent-ssh-fixture.js";
import { startSftpServer } from "./sftp-server.js";

export const PASSWORD = "pw-secret";

// An agent with the fixture's SSH hosts plus an SFTP host on an in-process server,
// its own workspace and a registered project folder outside AgentPier's data.
export async function setup(t, { remoteRoot = null } = {}) {
  const server = await startSftpServer();
  t.after(() => server.close());
  const f = await agentSshFixture(t, { hosts: [sftpRow(server, { remoteRoot })] });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-sftp-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspaces = path.join(base, "workspaces");
  const workspace = path.join(workspaces, f.id);
  fs.mkdirSync(workspace, { recursive: true });
  const folder = path.join(base, "project");
  fs.mkdirSync(folder);
  const project = await f.memory.register(folder);
  f.assistants.attachments = { config: { workspaces } };
  const guard = { live: true };
  f.assistants.config = { writeGuard: () => guard.live };
  const sftp = f.workflows.ssh.sftp;
  sftp.authorizeEveryMs = 20;
  // A card ends its call quickly unless a test decides within the hold.
  sftp.approvals.pollMs = 20;
  sftp.approvals.holdMs = 100;
  const access = (sshAccesses, projectFiles = {}) =>
    f.workflows.access.save(
      f.id,
      { ...f.policy, projectIds: [project.id], projectFiles, sshAccesses },
      f.workflows.access.get(f.id).revision,
    );
  const file = (root, relative, content) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  const sftpCall = (inv, input) => f.call(inv, { accessId: sftpHostId, ...input });
  const rows = () =>
    f.workflows.store.list(f.id).filter((a) => a.payload.action === "sftp");
  const sftpAudit = () => f.audit.filter((e) => e.action.startsWith("sftp."));
  return {
    ...f,
    server,
    workspace,
    folder,
    folderProject: project,
    guard,
    sftp,
    access,
    file,
    sftpCall,
    rows,
    sftpAudit,
  };
}
export const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected a refusal");
};
export async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}
