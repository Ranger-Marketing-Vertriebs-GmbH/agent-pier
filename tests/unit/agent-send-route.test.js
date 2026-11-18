import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sendRoute } from "../../web/features/assistants/send-route.js";
import { assistantCopy } from "../../web/lib/i18n/messages/assistants.js";

const message = { content: true };

test("an idle chat with a ready service sends at once", () => {
  assert.equal(sendRoute(message), "send");
});

// Regression: Enter did nothing while the agent service was not ready (reconnecting
// after a busy Gateway) or the agent worked on a team task; the text just stayed.
test("a message the service cannot take now is queued, never dropped in silence", () => {
  assert.equal(sendRoute({ ...message, direct: false }), "queue");
  assert.equal(sendRoute({ ...message, active: true }), "queue");
  assert.equal(sendRoute({ ...message, queued: true }), "queue");
  assert.equal(sendRoute({ ...message, compacting: true }), "queue");
  // The agent's turn ended while this tab's delivery still waits: queued, not refused.
  assert.equal(sendRoute({ ...message, busy: true, active: true }), "queue");
});

test("a delivery still under way and an unreachable AgentPier answer visibly", () => {
  assert.equal(sendRoute({ ...message, busy: true }), "sending");
  assert.equal(sendRoute({ ...message, busy: true, direct: false }), "sending");
  assert.equal(sendRoute({ ...message, offline: true, direct: false }), "offline");
  assert.equal(sendRoute({ content: false, direct: false }), "empty");
  assert.match(assistantCopy.sendUnderway, /\S/);
});

test("both chats route Enter through sendRoute and show a delivery under way", () => {
  for (const file of [
    "web/features/assistants/AssistantChat.jsx",
    "web/features/users/useUserConversation.js",
  ]) {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(source, /const route = sendRoute\(/, file);
    assert.match(source, /if \(route === "queue"\) return queue\(ids\);/, file);
    assert.match(
      source,
      /if \(route === "sending"\) setError\(\w*[cC]opy\.sendUnderway\);/,
      file,
    );
    // The old silent gate is gone.
    assert.doesNotMatch(source, /if \(!canSend\) return false;/, file);
  }
  const owner = fs.readFileSync(
    new URL("../../web/features/assistants/AssistantChat.jsx", import.meta.url),
    "utf8",
  );
  // Send is not disabled for a service that is not ready: the message queues instead.
  const gate = owner.slice(owner.indexOf("const canSend = Boolean("));
  assert.doesNotMatch(gate.slice(0, gate.indexOf(");")), /availability|busy|memberBusy/);
});
