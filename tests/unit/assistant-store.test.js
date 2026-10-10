import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
test("definitions retain identities and effective revision across reopen and reject stale edits", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let store = new AssistantStore({ dataDir });
  const assistant = store.createAssistant({
    name: "Home",
    instructions: "Help plan",
    model: { connectionId: "connection", modelId: "model" },
  });
  const chat = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "agent:home:chat",
  });
  store.updateAssistant(assistant.id, { name: "Planner" }, 1);
  assert.throws(() => store.updateAssistant(assistant.id, { name: "Stale" }, 1), {
    status: 409,
  });
  assert.equal(store.getAssistant(assistant.id).effectiveRevision, 0);
  store.close();
  store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  assert.equal(store.getAssistant(assistant.id).name, "Planner");
  assert.equal(store.getConversation(chat.id).runtimeSessionKey, "agent:home:chat");
  assert.equal(store.listAssistants().length, 1);
  assert.throws(
    () => store.updateAssistant(assistant.id, { runtimeAgentId: "foreign" }, 2),
    { status: 400 },
  );
});

test("two store connections observe revision conflicts and reject aliased storage", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-concurrent-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = new AssistantStore({ dataDir }),
    second = new AssistantStore({ dataDir });
  t.after(() => first.close());
  t.after(() => second.close());
  const a = first.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  second.updateAssistant(a.id, { name: "Other" }, 1);
  assert.throws(() => first.updateAssistant(a.id, { name: "Stale" }, 1), { status: 409 });
  assert.equal(first.getAssistant(a.id).name, "Other");
  const alias = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-alias-"));
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));
  fs.symlinkSync(path.join(dataDir, "assistants"), path.join(alias, "assistants"));
  assert.throws(() => new AssistantStore({ dataDir: alias }));
});
