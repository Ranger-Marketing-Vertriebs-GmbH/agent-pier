import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { ChannelOutbox } from "../../server/features/assistant-channels/channel-outbox.js";
test("outbox is separate, source-bound and idempotent across restart; unknown sends stay blocked", (t) => {
  const f = channelFixture(t),
    box = new ChannelOutbox(f.service.store.db),
    source = { channelId: f.channel.id, chatId: "42", userId: "42" };
  const input = { key: "team-result:one", source, kind: "team-result", text: "Done" };
  const entry = box.enqueue(input);
  assert.equal(box.enqueue(input).id, entry.id);
  assert.throws(() => box.enqueue({ ...input, text: "Changed" }), { status: 409 });
  box.transition(entry.id, "outbound", { state: "delivering" });
  const reopened = new ChannelOutbox(f.service.store.db);
  assert.equal(reopened.get(entry.id).state, "delivery_uncertain");
  assert.equal(reopened.enqueue(input).id, entry.id);
  assert.equal(f.service.ledger.list(f.channel.id).length, 0);
  assert.ok(!JSON.stringify(box.public(f.channel.id)).includes("userId"));
});
