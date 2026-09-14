import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ChatDraft, deliveryScope } from "../web/features/chat/chat-draft.js";

/** Exercise actual Codex clear plus the browser's durable reset presentation state. */
export async function probeNativeClear({
  fixture,
  session,
  send,
  capture,
  waitFor,
  version,
}) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  const reload = () => new ChatDraft(storage, deliveryScope(session), (_key, fn) => fn());
  const read = async () => {
    fixture.application.bindings.processCache.clear();
    fixture.application.chat.invalidate(session.id);
    const data = await fixture.application.chat.read(session.id);
    return { ...data, clientObservedAt: Date.now() };
  };
  await send("AP_PROBE_BEFORE_CLEAR");
  await waitFor(capture, (screen) =>
    screen.includes("Synthetic response complete: AP_PROBE_BEFORE_CLEAR"),
  );
  const before = await waitFor(
    read,
    (data) => data.availability === "ready" && data.messages.length >= 2,
  );
  const draft = reload();
  await draft.change({ text: "/clear" });
  const item = await draft.enqueue(randomUUID(), before.messages, {
    tool: "codex",
    providerSessionId: before.providerSessionId,
    restartGeneration: 0,
  });
  const receipt = await send(item.text, item.id);
  await draft.receipt(receipt);
  assert.equal(reload().getSnapshot().reset.status, "requested");
  await waitFor(
    capture,
    (screen) =>
      !screen.includes("Synthetic response complete: AP_PROBE_BEFORE_CLEAR") &&
      screen.includes("Ask Codex to do anything"),
  );
  const cleared = await read();
  await draft.observeReset(cleared, 0);
  const delayed = cleared.providerSessionId === before.providerSessionId;
  assert.equal(reload().getSnapshot().reset.status, delayed ? "requested" : "confirmed");
  await send("AP_PROBE_AFTER_CLEAR");
  await waitFor(capture, (screen) =>
    screen.includes("Synthetic response complete: AP_PROBE_AFTER_CLEAR"),
  );
  const after = await waitFor(
    read,
    (data) =>
      data.availability === "ready" &&
      data.providerSessionId !== before.providerSessionId,
  );
  await draft.observeReset(after, 0);
  assert.equal(reload().getSnapshot().reset.status, "confirmed");
  assert.ok(
    !after.messages.some((message) => message.text?.includes("AP_PROBE_BEFORE_CLEAR")),
  );
  console.log(
    JSON.stringify(
      {
        mode: "native-clear-local-mock",
        version,
        delayedIdentityObserved: delayed,
        requestedSurvivesReload: true,
        confirmedAfterNewPrompt: true,
        oldMessagesInNewThread: false,
      },
      null,
      2,
    ),
  );
}
