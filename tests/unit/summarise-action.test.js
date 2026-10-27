import test from "node:test";
import assert from "node:assert/strict";
import summariseAction from "../../web/features/assistants/chats/summarise-action.js";
import { agentChatsCopy as copy } from "../../web/lib/i18n/messages/agent-chats.js";

const base = {
  shown: true,
  longChat: { busy: false, summarise: () => "run" },
  available: true,
  working: false,
  compacting: false,
  empty: false,
};

test("Summarise now is absent where the owner may not summarise", () => {
  assert.equal(summariseAction({ ...base, shown: false }), null);
});

test("Summarise now runs the long-chat hint's action when nothing blocks it", () => {
  const action = summariseAction(base);
  assert.equal(action.reason, "");
  assert.equal(action.run(), "run");
});

test("Summarise now names why it is disabled", () => {
  assert.equal(summariseAction({ ...base, working: true }).reason, copy.summariseWorking);
  assert.equal(
    summariseAction({ ...base, longChat: { ...base.longChat, busy: true } }).reason,
    copy.summariseWorking,
  );
  assert.equal(
    summariseAction({ ...base, compacting: true, working: true }).reason,
    copy.summariseRunning,
  );
  assert.equal(summariseAction({ ...base, empty: true }).reason, copy.summariseEmpty);
  assert.equal(
    summariseAction({ ...base, available: false }).reason,
    copy.summariseUnavailable,
  );
});
