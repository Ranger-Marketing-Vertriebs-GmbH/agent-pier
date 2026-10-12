import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { personalShell } from "../../server/features/assistants/native-capabilities.js";

const model = { connectionId: "c", modelId: "m" };
function open(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-shell-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}
const create = (store, extra = {}) =>
  store.createAssistant({ name: "Home", model, ...extra });

test("the shell level defaults to off", (t) => {
  const agent = create(open(t));
  assert.equal(personalShell(agent), "off");
  assert.equal(personalShell({}), "off");
});

test("the three levels are accepted and anything else is rejected", (t) => {
  const store = open(t);
  let agent = create(store, { shell: "approval" });
  assert.equal(personalShell(agent), "approval");
  for (const shell of ["full", "off", "approval"]) {
    agent = store.updateAssistant(agent.id, { shell }, agent.revision);
    assert.equal(personalShell(store.getAssistant(agent.id)), shell);
  }
  for (const shell of ["ask", "", true, null, 1, "FULL"]) {
    assert.throws(() => store.updateAssistant(agent.id, { shell }, agent.revision), {
      status: 400,
    });
    assert.throws(() => create(store, { shell }), { status: 400 });
  }
});

test("temporary members and archived agents have no shell and cannot set one", (t) => {
  const store = open(t);
  const parent = create(store);
  const member = store.reserveMember({
    id: "member-1",
    parent: parent.id,
    assignment: { name: "Helper" },
    snapshot: { model, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  assert.equal(personalShell({ ...member, shell: "full" }), "off");
  assert.throws(() => store.updateAssistant(member.id, { shell: "full" }, 1), {
    status: 400,
  });
  const archived = { ...create(store, { shell: "full" }), archivedAt: "2026-01-01" };
  assert.equal(personalShell(archived), "off");
  const row = create(store);
  store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...row, archivedAt: "2026-01-01" }), row.id);
  assert.throws(() => store.updateAssistant(row.id, { shell: "approval" }, 1), {
    status: 400,
  });
});

test("a PATCH without shell keeps the stored level", (t) => {
  const store = open(t);
  const agent = create(store, { shell: "full" });
  const next = store.updateAssistant(agent.id, { name: "Renamed" }, 1);
  assert.equal(next.shell, "full");
  assert.equal(store.getAssistant(agent.id).shell, "full");
});
