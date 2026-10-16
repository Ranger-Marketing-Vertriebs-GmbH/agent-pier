import test from "node:test";
import assert from "node:assert/strict";
import { fixture, people, token } from "../helpers/assistant-telegram-senders-fixture.js";

test("SSH grants and an own bot for other people exclude each other", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  h.ssh.add(agent.id);
  await assert.rejects(
    h.senders.save(agent.id, { token: token(1), people, revision: null }),
    { status: 409, key: "telegramSendersSsh" },
  );
  assert.equal((await h.senders.get(agent.id)).ssh, true);
  h.ssh.clear();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  // A grant added later (outside this service) keeps the bot out of the compile.
  h.ssh.add(agent.id);
  assert.equal(
    (await h.senders.status((await h.senders.get(agent.id)).bot)).state,
    "inactive",
  );
  assert.deepEqual(h.snapshot().accounts, []);
});
