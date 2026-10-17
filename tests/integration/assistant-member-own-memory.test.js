import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { ownMemoryTarget } from "../../server/features/assistants/lead-request-writes.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";

// A running task member whose turn the lead gave it, and the bridge's write policy.
async function setup(t) {
  const f = await memberGrantFixture(t);
  const workspaces = path.join(f.dataDir, "workspaces");
  const agent = f.agent();
  fs.mkdirSync(path.join(workspaces, agent.id, "memory", "lead"), { recursive: true });
  f.assistants.runtime.paths = { workspaces };
  const bridge = new TeamBridge({ assistants: f.assistants, teams: { store: f.teams } });
  const request = f.assistants.ledger.accept(f.memberChat.id, {
    clientRequestId: "assignment",
    text: "Go",
  });
  f.teams.recordContext(request.id, {
    kind: "team-member",
    teamId: f.member.teamId,
    memberId: f.member.id,
  });
  f.assistants.ledger.recordAttempt(request.id);
  const write = (target) =>
    bridge.writeAllowed({
      agentId: agent.runtimeAgentId,
      sessionKey: "member-session",
      toolName: "write",
      path: target,
    });
  return { ...f, workspaces, agent, write };
}

test("a member writes its own memory, never the copy of its lead's or anything else", async (t) => {
  const f = await setup(t);
  for (const target of ["MEMORY.md", "memory/2026-10-17.md", "memory/topics/atlas.md"])
    assert.equal(f.write(target), true, target);
  for (const target of [
    "memory/lead/MEMORY.md",
    "memory/LEAD/notes.md",
    "./memory/lead/x.md",
    "memory/../memory/lead/x.md",
    "notes.txt",
    "src/app.js",
    "../other/MEMORY.md",
  ])
    assert.equal(f.write(target), false, target);
});

test("a linked memory folder never lets a member write elsewhere", async (t) => {
  const f = await setup(t);
  const own = path.join(f.workspaces, f.agent.id);
  const lead = path.join(f.workspaces, f.id);
  fs.mkdirSync(path.join(lead, "memory"), { recursive: true });
  // The member (with shell) swapped its memory/ for a link to the lead's.
  fs.rmSync(path.join(own, "memory"), { recursive: true });
  fs.symlinkSync(path.join(lead, "memory"), path.join(own, "memory"));
  assert.equal(f.write("memory/notes.md"), false);
  assert.equal(
    ownMemoryTarget(f.workspaces, f.agent.runtimeAgentId, "memory/notes.md"),
    false,
  );
  // A linked MEMORY.md is refused as well.
  fs.rmSync(path.join(own, "memory"));
  fs.symlinkSync(path.join(lead, "MEMORY.md"), path.join(own, "MEMORY.md"));
  assert.equal(f.write("MEMORY.md"), false);
});

test("the owner can read a member's own memory in its settings", async (t) => {
  const f = await setup(t);
  const own = path.join(f.workspaces, f.agent.id);
  fs.writeFileSync(path.join(own, "memory", "2026-10-17.md"), "Found the bug");
  const memory = new NativeMemory(f.assistants, { workspaces: f.workspaces });
  const { files } = await memory.listNotes(f.agent.id);
  assert.deepEqual(
    files.map((file) => file.name),
    ["memory/2026-10-17.md"],
  );
  const note = await memory.readNote(f.agent.id, "memory/2026-10-17.md");
  assert.equal(note.content, "Found the bug");
});
