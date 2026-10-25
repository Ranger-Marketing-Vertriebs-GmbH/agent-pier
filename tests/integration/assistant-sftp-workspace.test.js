import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sftpHostId } from "../helpers/agent-ssh-fixture.js";
import { code, setup } from "../helpers/agent-sftp-fixture.js";
import { partFiles, tree } from "../helpers/sftp-transfer-fixture.js";

// The agent's workspace as the local side keeps away from what the native tool
// guard protects there (team-plugin/tool-guard.js guardedWorkspaceEntry).
test("downloads never write the workspace's prompt files, skills, attachments or .agentpier", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "AGENTS.md", "own instructions");
  f.file(f.server.root, "repo/AGENTS.md", "evil instructions");
  f.file(f.server.root, "repo/skills/x/SKILL.md", "evil skill");
  f.file(f.server.root, "repo/site/index.html", "page");
  const refused = (input) =>
    code(f.sftpCall(f.ownTurn(), { remotePath: "/repo", ...input }));
  // A sync down into the workspace itself would overwrite AGENTS.md.
  for (const input of [
    { action: "sync", direction: "down" },
    { action: "sync", direction: "down", localPath: "." },
    { action: "download", localPath: "." },
    { action: "download", remotePath: "/repo/AGENTS.md" },
    { action: "download", remotePath: "/repo/AGENTS.md", localPath: "Agents.md" },
    { action: "download", remotePath: "/repo/skills", localPath: "skills" },
    { action: "download", remotePath: "/repo/site", localPath: "SKILLS/site" },
    { action: "download", remotePath: "/repo/site", localPath: ".agents/site" },
    { action: "download", remotePath: "/repo/site", localPath: "attachments/site" },
    { action: "download", remotePath: "/repo/site", localPath: "Ägents/site" },
    { action: "download", remotePath: "/repo/site", localPath: ".agentpier/site" },
    { action: "download", remotePath: "/repo/site", localPath: ".AgentPier/site" },
  ])
    assert.equal(await refused(input), "SFTP_WORKSPACE_REFUSED", JSON.stringify(input));
  // A link to a guarded folder is checked where it leads.
  fs.mkdirSync(path.join(f.workspace, "skills"));
  fs.symlinkSync("skills", path.join(f.workspace, "docs"));
  assert.equal(
    await refused({
      action: "download",
      remotePath: "/repo/site",
      localPath: "docs/site",
    }),
    "SFTP_WORKSPACE_REFUSED",
  );
  fs.rmSync(path.join(f.workspace, "docs"));
  fs.rmSync(path.join(f.workspace, "skills"), { recursive: true });
  assert.deepEqual(tree(f.workspace), { "AGENTS.md": "own instructions" });
  assert.deepEqual(partFiles(f.workspace), []);
  // The refusals came before any sign-in.
  assert.equal(f.server.authAttempts(), 0);
  // A named subfolder is fine, even though the remote tree carries AGENTS.md.
  const synced = await f.sftpCall(f.ownTurn(), {
    action: "sync",
    direction: "down",
    remotePath: "/repo",
    localPath: "mirror",
  });
  assert.equal(synced.status, "completed");
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "AGENTS.md"), "utf8"),
    "own instructions",
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "mirror/AGENTS.md"), "utf8"),
    "evil instructions",
  );
});

test("uploads never read the workspace's prompt files, skills, attachments or .agentpier", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "AGENTS.md", "instructions");
  f.file(f.workspace, "USER.md", "about the owner");
  f.file(f.workspace, "skills/x/SKILL.md", "skill");
  f.file(f.workspace, ".agents/x.md", "agent");
  f.file(f.workspace, "attachments/other-chat.pdf", "someone else's upload");
  f.file(f.workspace, ".agentpier/secrets.env", "TOKEN='secret'");
  f.file(f.workspace, "site/index.html", "page");
  // An upload of the whole workspace leaves every guarded entry out.
  for (const input of [
    { action: "sync", direction: "up", remotePath: "/backup" },
    { action: "upload", localPath: ".", remotePath: "/copy" },
    { action: "upload", localPath: ".", remotePath: "/plain", defaultExcludes: false },
  ]) {
    const result = await f.sftpCall(f.ownTurn(), input);
    assert.equal(result.status, "completed", JSON.stringify(input));
    assert.equal(result.files, 1, JSON.stringify(input));
  }
  assert.deepEqual(tree(f.server.root), {
    "backup/site/index.html": "page",
    "copy/site/index.html": "page",
    "plain/site/index.html": "page",
  });
  // Naming a guarded entry, or a path inside one, is refused.
  for (const localPath of [
    "attachments",
    "attachments/other-chat.pdf",
    "AGENTS.md",
    "skills",
    ".agentpier",
    ".agentpier/secrets.env",
  ])
    assert.equal(
      await code(
        f.sftpCall(f.ownTurn(), { action: "upload", localPath, remotePath: "/x" }),
      ),
      "SFTP_WORKSPACE_REFUSED",
      localPath,
    );
  assert.equal(JSON.stringify(f.rows()).includes("other-chat"), false);
});

test("the job's time limit fails it instead of cancelling it", async (t) => {
  const f = await setup(t);
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("SFTP_TIMEOUT"), { code: "SFTP_TIMEOUT" }));
  const outcome = await f.sftp.runs.execute(
    {
      id: null,
      meta: {},
      session: { close() {} },
      access: {},
      work: async () => ({ state: "cancelled", code: "SFTP_CANCELLED" }),
    },
    () => {},
    controller.signal,
  );
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.code, "SFTP_TIMEOUT");
});

test("a single file downloads to the workspace's top level under an unguarded name", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "AGENTS.md", "own instructions");
  f.file(f.server.root, "repo/notes.md", "notes");
  f.file(f.server.root, "repo/AGENTS.md", "evil instructions");
  const download = (input) =>
    f.sftpCall(f.ownTurn(), {
      action: "download",
      remotePath: "/repo/notes.md",
      ...input,
    });
  assert.equal((await download({})).status, "completed");
  assert.equal((await download({ localPath: "copy.md" })).status, "completed");
  assert.equal(fs.readFileSync(path.join(f.workspace, "notes.md"), "utf8"), "notes");
  assert.equal(fs.readFileSync(path.join(f.workspace, "copy.md"), "utf8"), "notes");
  for (const localPath of ["AGENTS.md", "agents.MD", "./Agents.md"])
    assert.equal(
      await code(download({ localPath })),
      "SFTP_WORKSPACE_REFUSED",
      localPath,
    );
  assert.equal(
    await code(download({ remotePath: "/repo/AGENTS.md" })),
    "SFTP_WORKSPACE_REFUSED",
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "AGENTS.md"), "utf8"),
    "own instructions",
  );
});

test("an attachments folder that appears after the local check is still left out", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "site/index.html", "page");
  // The first upload of a shared agent arrives while AgentPier signs in.
  const open = f.sftp.open;
  f.sftp.open = async (credentials) => {
    f.file(f.workspace, "attachments/new-upload.pdf", "someone else's file");
    return open(credentials);
  };
  const result = await f.sftpCall(f.ownTurn(), {
    action: "sync",
    direction: "up",
    remotePath: "/backup",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(tree(f.server.root), { "backup/site/index.html": "page" });
});
