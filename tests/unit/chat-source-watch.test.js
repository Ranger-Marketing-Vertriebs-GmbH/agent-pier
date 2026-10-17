import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { watchChatSources } from "../../server/features/chat/chat-source-watch.js";

function sources(t, settleMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  let changes = 0;
  const unwatch = watchChatSources(
    {
      session: { id: "s", accountId: "a", tool: "codex" },
      accounts: { environment: () => ({ HOME: home }) },
      dataDir: path.join(root, "data"),
      home,
      settleMs,
    },
    () => changes++,
  );
  t.after(unwatch);
  return { unwatch, changes: () => changes };
}

test("watchers re-check once after arming so a write during startup is not missed", async (t) => {
  const watch = sources(t, 20);
  assert.equal(watch.changes(), 0);
  await delay(120);
  assert.equal(watch.changes(), 1);
});

test("disposing the watchers cancels the startup re-check", async (t) => {
  const watch = sources(t, 20);
  watch.unwatch();
  await delay(120);
  assert.equal(watch.changes(), 0);
});
