import test from "node:test";
import assert from "node:assert/strict";
import { TelegramOutbox } from "../../server/features/assistant-channels/telegram-outbox.js";

test("a team transfer's failure and recovery signal only its channel", () => {
  const written = [];
  let changes = 0;
  const outbox = new TelegramOutbox({
    written: (channelId) => written.push(channelId),
    assistants: { changed: () => (changes += 1) },
  });
  outbox.failed("team-1", "channel-a");
  outbox.failed("team-1", "channel-a");
  assert.equal(outbox.diagnostic("channel-a"), "TEAM_NOTIFICATION_FAILED");
  assert.equal(outbox.diagnostic("channel-b"), null);
  outbox.recovered("team-1");
  outbox.recovered("team-1");
  // The team list as a whole has no channel: every agent reads again.
  outbox.failed("*", null);
  outbox.recovered("*");
  assert.deepEqual(written, ["channel-a", "channel-a", null, null]);
  assert.equal(changes, 4);
});
