import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestApprovals } from "../../server/features/requests/request-approvals.js";
import { buildSessionLaunch } from "../../server/features/sessions/session-creation.js";

// The default list answers `git` and `npm` only inside the session's project. A
// session always has a folder: creation refuses one without. Should a request ever
// arrive for a session without one, nothing a repository defines runs unasked.

const request = (command, cwd) => ({
  kind: "permission",
  source: "claude",
  subject: { tool: "Bash", command, ...(cwd ? { cwd } : {}) },
  options: [
    { id: "allow", label: "Allow", scope: "once" },
    { id: "deny", label: "Deny" },
  ],
});

test("a session cannot be created without an existing absolute folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "file");
  await fs.writeFile(file, "x");
  for (const cwd of [
    undefined,
    null,
    "",
    "relative/folder",
    path.join(root, "gone"),
    file,
  ])
    await assert.rejects(
      buildSessionLaunch(
        {},
        {
          tool: "claude",
          accountId: "account-1",
          name: "Folder",
          cwd,
          command: "/bin/sh",
        },
      ),
      { message: "Ungültiges Arbeitsverzeichnis." },
      String(cwd),
    );
});

test("without a session folder git and npm ask; plain reads stay", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-approvals-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const approvals = new RequestApprovals({
    directory,
    scope: async () => ({ id: "project-1" }),
  });
  for (const session of [{ id: "s-1" }, { id: "s-1", cwd: "relative" }]) {
    for (const command of [
      "git status",
      "git log -3",
      "git diff",
      "git fetch origin",
      "npm test",
      "npm run lint",
      "cd sub && git status",
    ])
      assert.equal(await approvals.prepare(request(command), session), null, command);
    for (const command of ["git rev-parse HEAD", "git branch", "cat README.md", "ls"])
      assert.deepEqual(
        await approvals.prepare(request(command), session),
        { choice: "allow", decision: "allow-default" },
        command,
      );
    // A folder the CLI reports for its shell is no project without a session folder.
    assert.equal(
      await approvals.prepare(request("git status", "/work/repo"), session),
      null,
    );
  }
});

test("with a session folder the same commands need no card", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-approvals-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const approvals = new RequestApprovals({
    directory,
    scope: async () => ({ id: "project-1" }),
  });
  const session = { id: "s-1", cwd: "/work/repo" };
  for (const command of ["git status", "npm test", "cd sub && git log -3"])
    assert.deepEqual(
      await approvals.prepare(request(command), session),
      { choice: "allow", decision: "allow-default" },
      command,
    );
});
