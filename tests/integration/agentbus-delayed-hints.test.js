import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { makeTools } from "../../vendor/agentbus/mcp/tools.js";
import { openQueue } from "../../vendor/agentbus/core/queue.js";
import { send } from "../../vendor/agentbus/core/send.js";

for (const runtime of ["codex", "claude", "opencode"]) {
  test(`${runtime}: delayed wake hints identify messages already consumed by a batched read`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentbus-delayed-"));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const self = {
      key: "codex-sender",
      name: "sender",
      runtime: "codex",
      sessionId: "sender",
      cwd: "/fixture",
    };
    const target = { key: `${runtime}-target`, name: "target", runtime, alive: true };
    const hints = [];
    const deps = {
      listPeers: () => [target],
      nudgeFn: async (_peer, text) => {
        hints.push(text);
        return true;
      },
    };
    const first = await send(
      home,
      { self, to: "target", text: "first fixture message" },
      deps,
    );
    const second = await send(
      home,
      { self, to: "target", text: "second fixture message" },
      deps,
    );
    assert.match(hints[0], /zum Versandzeitpunkt/);
    assert.ok(hints[0].includes(`inbox_read({"messageId":"${first.id}"})`));
    assert.ok(hints[1].includes(`inbox_read({"messageId":"${second.id}"})`));
    const inbox = makeTools(home, () => target).find(
      (tool) => tool.name === "inbox_read",
    );
    const read = await inbox.run({ messageId: first.id });
    assert.match(read, /first fixture message/);
    assert.match(read, /second fixture message/);
    const late = await inbox.run({ messageId: second.id });
    assert.match(late, /bereits.*abgeholt/);
    assert.match(late, /verspätet/);
    assert.doesNotMatch(late, /second fixture message/);
    // A later genuine message must still be delivered, even if an old hint is used.
    await send(home, { self, to: "target", text: "third fixture message" }, deps);
    assert.match(await inbox.run({ messageId: second.id }), /third fixture message/);
    // Legacy callers remain compatible and get an explanation without inventing an ack.
    assert.match(await inbox.run({}), /Hinweise können verspätet/);
    const outsider = makeTools(home, () => ({ key: "claude-other" })).find(
      (tool) => tool.name === "inbox_read",
    );
    assert.doesNotMatch(await outsider.run({ messageId: first.id }), /wurde bereits/);
  });
}

test("hint references distinguish in-flight claims and invalid references cannot consume messages", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentbus-claimed-"));
  const queue = openQueue(home);
  t.after(() => {
    queue.close();
    return fs.rm(home, { recursive: true, force: true });
  });
  queue.enqueue({
    id: "fixture-id",
    ts: Date.now(),
    from: { name: "sender" },
    to: "codex-target",
    text: "private fixture",
  });
  const inbox = makeTools(home, () => ({ key: "codex-target" })).find(
    (tool) => tool.name === "inbox_read",
  );
  await assert.rejects(
    inbox.run({ messageId: "../../bad" }),
    /invalid message reference/,
  );
  assert.equal(queue.summary("codex-target").count, 1);
  const claim = queue.claim("codex-target", "other-reader", Date.now(), 60000);
  assert.match(await inbox.run({ messageId: "fixture-id" }), /anderen inbox_read/);
  assert.equal(queue.ack("other-reader", claim.claimIds), 1);
  assert.match(await inbox.run({ messageId: "fixture-id" }), /wurde bereits/);
});
