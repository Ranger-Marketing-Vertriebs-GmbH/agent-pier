import test from "node:test";
import assert from "node:assert/strict";
import { AssistantDrafts } from "../../web/features/assistants/assistant-drafts.js";
test("drafts and delivery keys stay separate per chat and survive uncertain delivery", () => {
  const drafts = new AssistantDrafts();
  drafts.set("one", "Dinner");
  drafts.set("two", "Network");
  const first = drafts.delivery("one");
  assert.equal(drafts.get("one"), "Dinner");
  assert.equal(drafts.get("two"), "Network");
  assert.equal(drafts.delivery("one").clientRequestId, first.clientRequestId);
  drafts.set("one", "New dinner");
  assert.notEqual(drafts.delivery("one").clientRequestId, first.clientRequestId);
  drafts.clear("one");
  assert.equal(drafts.get("one"), "");
  assert.equal(drafts.get("two"), "Network");
});
test("a failed delivery returns to an empty field with its delivery key", () => {
  const drafts = new AssistantDrafts();
  drafts.set("chat", "First");
  drafts.allowTeam("chat", true);
  const sent = drafts.delivery("chat");
  drafts.clear("chat");
  assert.equal(drafts.restore("chat", sent), "First");
  assert.equal(drafts.teamAllowed("chat"), true);
  assert.equal(drafts.delivery("chat").clientRequestId, sent.clientRequestId);
});
test("a failed delivery comes before what was typed since, as a new message", () => {
  const drafts = new AssistantDrafts();
  drafts.set("chat", "First");
  const sent = drafts.delivery("chat");
  drafts.clear("chat");
  drafts.set("chat", "Second");
  assert.equal(drafts.restore("chat", sent), "First\nSecond");
  assert.notEqual(drafts.delivery("chat").clientRequestId, sent.clientRequestId);
});
test("one-message team permission follows its draft identity and is cleared after acceptance", () => {
  const drafts = new AssistantDrafts();
  drafts.set("chat", "Plan");
  drafts.allowTeam("chat", true);
  const sent = drafts.delivery("chat");
  assert.equal(sent.teamAllowed, true);
  drafts.set("chat", "Edited");
  assert.equal(drafts.teamAllowed("chat"), true);
  assert.notEqual(drafts.delivery("chat").clientRequestId, sent.clientRequestId);
  drafts.clear("chat");
  assert.equal(drafts.teamAllowed("chat"), false);
});
test("other attachments give the same text a new delivery key", () => {
  const drafts = new AssistantDrafts();
  drafts.attach("chat");
  drafts.set("chat", "Look at this");
  const first = drafts.delivery("chat");
  assert.equal(drafts.delivery("chat").clientRequestId, first.clientRequestId);
  drafts.attach("chat");
  assert.equal(drafts.get("chat"), "Look at this");
  assert.notEqual(drafts.delivery("chat").clientRequestId, first.clientRequestId);
});
test("a logout forgets every chat's draft", () => {
  const drafts = new AssistantDrafts();
  drafts.set("one", "Dinner");
  drafts.allowTeam("two", true);
  drafts.clearAll();
  assert.equal(drafts.get("one"), "");
  assert.equal(drafts.teamAllowed("two"), false);
});
