import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";

test("trusted SSH rows are pruned to the newest per agent", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-rows-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const model = { connectionId: "c", modelId: "m" };
  const a = store.createAssistant({ name: "A", model }),
    b = store.createAssistant({ name: "B", model });
  const actions = new AssistantActionStore(store.db);
  const row = (assistantId, key, payload) =>
    actions.reserve({
      assistantId,
      conversationId: "chat",
      origin: { kind: "owner" },
      key,
      state: "completed",
      settled: true,
      payload,
    });
  for (let n = 0; n < 6; n++)
    row(a.id, `ssh:a:${n}`, { action: "ssh", trusted: true, commandSha256: `${n}` });
  row(b.id, "ssh:b:0", { action: "ssh", trusted: true, commandSha256: "b" });
  row(a.id, "memory:1", { action: "memory_write" });
  row(a.id, "ssh:a:approval", { action: "ssh", command: "uptime" });
  actions.pruneTrusted(a.id, "ssh", 4);
  assert.deepEqual(
    actions
      .list(a.id)
      .filter((x) => x.payload.trusted)
      .map((x) => x.payload.commandSha256),
    ["2", "3", "4", "5"],
  );
  assert.equal(actions.list(b.id).length, 1);
  assert.ok(actions.list(a.id).some((x) => x.payload.action === "memory_write"));
  assert.ok(actions.list(a.id).some((x) => x.payload.command === "uptime"));
});
