import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { guardedWorkspaceEntry } from "../../server/features/assistants/team-plugin/tool-guard.js";

const owner = (f) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: f.channel.chatId,
  userId: f.channel.userId,
  forwarded: false,
});

test("no file tool changes .agentpier, not even in the owner's own turn", async (t) => {
  const f = await workflowFixture(t);
  const { call, patch, root, workspace } = await nativeWriteGuard(t, f);
  fs.mkdirSync(path.join(workspace, ".agentpier"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".agentpier", "secrets.env"), "A='1'\n");
  const turn = await f.invocation("owner-write", owner(f));
  assert.equal(await call("notes.md"), true, "the owner's turn writes elsewhere");
  for (const target of [
    ".agentpier/secrets.env",
    "./.agentpier/secrets.env",
    ".AgentPier/secrets.env",
    ".agentpier/new.env",
    ".agentpier",
    "notes/../.agentpier/secrets.env",
    `${root}/${f.id}/.agentpier/secrets.env`,
  ])
    for (const toolName of ["write", "edit"])
      assert.equal(await call(target, { toolName }), false, `${toolName} ${target}`);
  for (const lines of [
    ["*** Delete File: .agentpier/secrets.env"],
    ["*** Update File: notes.md", "*** Move to: .agentpier/x", "@@", "-a", "+b"],
    ["*** Add File: .agentpier/x", "+X"],
    ["*** Update File: .agentpier/secrets.env", "@@", "-A='1'", "+A='2'"],
  ])
    assert.equal(await patch(lines), false, JSON.stringify(lines));
  // A link into the folder, or a hard link of its file, is checked where it leads.
  fs.symlinkSync(".agentpier", path.join(workspace, "config"));
  fs.symlinkSync(".agentpier/secrets.env", path.join(workspace, "env.txt"));
  // A write through a dangling link creates the file it points to.
  fs.symlinkSync(".agentpier/planted.env", path.join(workspace, "dangling.txt"));
  fs.symlinkSync("loop-b/x", path.join(workspace, "loop-a"));
  fs.symlinkSync("loop-a/y", path.join(workspace, "loop-b"));
  fs.linkSync(
    path.join(workspace, ".agentpier", "secrets.env"),
    path.join(workspace, "copy.env"),
  );
  for (const target of [
    "config/secrets.env",
    "config/new.env",
    "env.txt",
    "copy.env",
    "dangling.txt",
    // Links that never resolve cannot be verified.
    "loop-a",
  ])
    assert.equal(await call(target), false, `${target} leads into .agentpier`);
  assert.equal(await patch(["*** Delete File: copy.env"]), false);
  assert.equal(await call("notes.md"), true);
  f.assistants.ledger.transition(turn.attemptId, "completed");
  assert.equal(
    fs.readFileSync(path.join(workspace, ".agentpier", "secrets.env"), "utf8"),
    "A='1'\n",
  );
});

test("AgentPier's own transfers keep away from .agentpier", () => {
  for (const name of [".agentpier", ".AgentPier", ".AGENTPIER"])
    assert.equal(guardedWorkspaceEntry(name), true, name);
  assert.equal(guardedWorkspaceEntry("agentpier"), false);
});
