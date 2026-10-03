import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { issueCapability } from "../../server/features/memory/memory-capability.js";
import {
  directoryProjectId,
  folderIdentity,
  gitInitRebind,
} from "../../server/features/memory/project-rebind.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-rebind-")));
  const memory = new ProjectMemory({ dataDir: path.join(root, "data") });
  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  return { root, memory, cwd };
}
const session = {
  kind: "session",
  sessionId: "s1",
  accountId: "local-codex",
  tool: "codex",
};

test("adopting a folder that became a repository moves entries, requests and capabilities", async (t) => {
  const { memory, cwd } = fixture(t);
  const plain = await memory.register(cwd);
  assert.equal(plain.id, directoryProjectId(folderIdentity(cwd)));
  issueCapability(memory, {
    id: "s1",
    account: { id: "local-codex", tool: "codex" },
    projectId: plain.id,
  });
  memory.write(plain.id, { title: "Note", content: "Kept", requestId: "r1" }, session);
  assert.equal(await gitInitRebind(cwd), null, "A plain folder is not a rebind");
  execFileSync("git", ["init", "-q", cwd]);
  const found = await gitInitRebind(cwd);
  assert.equal(found.fromId, plain.id);
  const adopted = memory.adopt(found.fromId, found.scope);
  assert.equal(adopted.kind, "git");
  assert.equal(memory.reboundTo(plain.id), adopted.id);
  assert.equal(memory.list(adopted.id).total, 1);
  assert.throws(() => memory.project(plain.id), { status: 404 });
  const capability = memory.db
    .prepare("SELECT project_id FROM capabilities WHERE session_id='s1'")
    .get();
  assert.equal(capability.project_id, adopted.id);
  const replay = memory.write(
    adopted.id,
    { title: "Note", content: "Kept", requestId: "r1" },
    session,
  );
  assert.equal(replay.revision, 1, "The request receipt moved along");
  assert.deepEqual(memory.adopt(found.fromId, found.scope), adopted, "Idempotent");
});

test("a recorded rebind never adopts a different repository identity", async (t) => {
  const { memory, cwd } = fixture(t);
  const plain = await memory.register(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  const first = await gitInitRebind(cwd);
  memory.adopt(plain.id, first.scope);
  fs.rmSync(path.join(cwd, ".git"), { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  const second = await gitInitRebind(cwd);
  assert.equal(second.fromId, plain.id);
  assert.notEqual(second.scope.id, first.scope.id);
  assert.throws(() => memory.adopt(plain.id, second.scope), { status: 409 });
  assert.equal(memory.reboundTo(plain.id), first.scope.id);
});
