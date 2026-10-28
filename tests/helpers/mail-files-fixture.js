import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mailFixture } from "./agent-mail-fixture.js";

/**
 * The mail fixture plus the agent's workspace and a registered project folder, both
 * outside AgentPier's data directory (as agent-sftp-fixture.js `setup`), with the
 * write guard live. `access` saves the mail grant and the project grants in one
 * `access.save` and sets the agent's shell level; `ws` and `proj` name absolute
 * paths in the workspace and the project, `file` writes one, and `mail` calls the
 * tool on the owner's own turn by default.
 */
export async function mailFilesFixture(t) {
  const f = await mailFixture(t);
  // Real paths: on macOS the temp directory is reached through a link (/var).
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-files-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspaces = path.join(base, "workspaces");
  const workspace = path.join(workspaces, f.id);
  fs.mkdirSync(workspace, { recursive: true });
  const folder = path.join(base, "project");
  fs.mkdirSync(folder);
  const project = await f.memory.register(folder);
  f.assistants.attachments = { ...f.assistants.attachments, config: { workspaces } };
  const guard = { live: true };
  f.assistants.config = { ...f.assistants.config, writeGuard: () => guard.live };
  const access = ({
    level = "read",
    recipients,
    projectFiles = {},
    shell = "off",
  } = {}) => {
    f.workflows.access.save(
      f.id,
      {
        ...f.policy,
        projectIds: [project.id],
        projectFiles,
        mailAccesses: level
          ? [{ accountId: f.account.id, level, ...(recipients && { recipients }) }]
          : [],
      },
      f.workflows.access.get(f.id).revision,
    );
    const agent = f.store.getAssistant(f.id);
    if (agent.shell !== shell) f.store.updateAssistant(f.id, { shell }, agent.revision);
  };
  const ws = (relative) => path.join(workspace, relative);
  const proj = (relative) => path.join(folder, relative);
  const file = (target, content = "content") => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const mail = (input, inv = f.ownTurn()) => f.call(inv, input);
  return {
    ...f,
    base,
    workspaces,
    workspace,
    folder,
    folderProject: project,
    guard,
    access,
    ws,
    proj,
    file,
    mail,
  };
}
