import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";
import { withoutUnchanged } from "../../server/features/assistants/shell-changes.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-visible-"));
  const s = new AssistantStore({ dataDir });
  t.after(() => {
    s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return s;
}
const definition = {
  name: "Shopper",
  instructions: "",
  model: { connectionId: "c", modelId: "m" },
  capabilities: { memory: false, reminders: false, browser: true },
};

test("the visible browser window is an owner setting of eligible agents", (t) => {
  const s = store(t);
  const created = s.createAssistant(definition);
  const saved = s.updateAssistant(created.id, { browserVisible: true }, created.revision);
  assert.equal(saved.browserVisible, true);
  assert.equal(s.getAssistant(created.id).browserVisible, true);
  // Other saves keep it.
  const renamed = s.updateAssistant(created.id, { name: "Renamed" }, saved.revision);
  assert.equal(renamed.browserVisible, true);
  assert.throws(() => validateDefinition({ browserVisible: "yes" }, true));
  // An archived agent may only restate "off".
  const archived = { ...renamed, archivedAt: new Date().toISOString() };
  s.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(archived), created.id);
  assert.throws(() =>
    s.updateAssistant(created.id, { browserVisible: true }, renamed.revision),
  );
  assert.doesNotThrow(() =>
    s.updateAssistant(created.id, { browserVisible: false }, renamed.revision),
  );
});

test("an unchanged window setting is no change, and a changed one needs a restart check", () => {
  const current = { browserVisible: true };
  assert.deepEqual(
    withoutUnchanged({ browserVisible: true }, { browserVisible: true }, current),
    {},
  );
  assert.deepEqual(
    withoutUnchanged({ browserVisible: false }, { browserVisible: false }, current),
    { browserVisible: false },
  );
  const changes = new WebToolsChanges({
    assistants: {
      store: {
        listAssistants: () => [{ id: "a", capabilities: { browser: true } }, { id: "b" }],
      },
    },
  });
  assert.deepEqual(changes.profilesWith("a", { browserVisible: true }), [
    { id: "a", capabilities: { browser: true }, browserVisible: true },
    { id: "b" },
  ]);
});
