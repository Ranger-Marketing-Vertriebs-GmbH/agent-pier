import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import { openQueue } from "../../vendor/agentbus/core/queue.js";
import { peerKey } from "../../vendor/agentbus/core/paths.js";

for (const [first, second, truncated] of [
  [5001, 0, true],
  [2500, 2501, true],
  [5000, 0, false],
]) {
  test(`history reports its scan limit for recipient counts ${first}/${second}`, async (t) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentbus-limit-")),
    );
    const projectId = "a".repeat(64),
      h = path.join(root, "projects", projectId);
    const rows = ["first", "second"].map((id) => ({
      id,
      accountId: "fixture",
      tool: "codex",
      cwd: root,
      agentbus: { enabled: true, projectId },
    }));
    fs.mkdirSync(path.join(h, "launches"), { recursive: true });
    fs.mkdirSync(path.join(h, "identities"));
    for (const row of rows) {
      fs.writeFileSync(
        path.join(h, "launches", `${row.id}.json`),
        JSON.stringify({ ...row, projectId }),
      );
      const key = peerKey("codex", row.id);
      fs.writeFileSync(
        path.join(h, "identities", `${key}.json`),
        JSON.stringify({
          key,
          runtime: "codex",
          sessionId: row.id,
          nativeSessionId: row.id,
          agentpierSessionId: row.id,
          cwd: root,
          name: row.id,
        }),
      );
    }
    const queue = openQueue(h);
    t.after(() => {
      queue.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    for (const [index, count] of [first, second].entries()) {
      for (let i = 0; i < count; i++)
        queue.enqueue({
          id: `message-${index}-${i}`,
          ts: 1700000000000 + i,
          from: {
            runtime: "codex",
            sessionId: rows[1 - index].id,
            name: "sender",
            cwd: root,
          },
          to: peerKey("codex", rows[index].id),
          toName: rows[index].id,
          text: "Fixture message",
        });
    }
    const result = await AgentBus.prototype.messages.call(
      { root, sessions: { list: async () => rows }, queue: () => queue },
      projectId,
    );
    assert.equal(result.total, 5000);
    assert.equal(result.truncated, truncated);
    assert.equal(Boolean(result.note), truncated);
    assert.equal(result.items.length, 20);
    assert.equal(queue.summary(peerKey("codex", "first")).count, first);
    assert.equal(queue.summary(peerKey("codex", "second")).count, second);
  });
}
