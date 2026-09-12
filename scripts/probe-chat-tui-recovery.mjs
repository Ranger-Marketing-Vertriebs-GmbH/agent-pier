import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectChatComposer } from "../server/features/sessions/session-chat-input.js";

/** Inject a proven post-paste journal failure only in this disposable application. */
export async function probeNativeRecovery(fixture, session, snapshot, counts) {
  const delivery = fixture.application.chatDelivery;
  const manager = fixture.application.sessions;
  const target = `${manager.target(session.id)}:0.0`;
  const deliveryScope = JSON.stringify([
    session.id,
    session.accountId,
    session.tool,
    session.createdAt || null,
  ]);
  async function leaveDraft(text) {
    const deliveryId = randomUUID();
    const original = delivery.write.bind(delivery);
    let injected = false;
    delivery.write = (file, receipt) => {
      original(file, receipt);
      if (
        !injected &&
        receipt.deliveryId === deliveryId &&
        receipt.journal?.phase === "pasted"
      ) {
        injected = true;
        throw new Error("Synthetic failure after persisted paste");
      }
    };
    try {
      const response = await fixture.request(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: { deliveryId, deliveryScope, text, submit: true },
      });
      assert.equal((await response.json()).status, "uncertain");
      assert.equal(injected, true);
    } finally {
      delivery.write = original;
    }
    for (let n = 0; n < 100; n++) {
      const screen = await snapshot();
      const composer = inspectChatComposer(session.tool, screen.raw, screen.pane);
      if (composer.state === "text" && composer.text === text) return deliveryId;
      await sleep(20);
    }
    throw new Error("Native draft could not be reconstructed completely");
  }
  async function recover(deliveryId, text, body = {}) {
    const response = await fixture.request(
      `/api/sessions/${session.id}/input/${deliveryId}/recovery`,
      {
        method: "POST",
        body: {
          deliveryScope,
          text,
          attemptId: randomUUID(),
          expectedAttemptId: deliveryId,
          mode: "retry",
          ...body,
        },
      },
    );
    return response.json();
  }
  const text = "AP_PROBE_RECOVERY";
  const preBinding = fixture.application.bindings.verifiedReceipt(session);
  const deliveryId = await leaveDraft(text);
  const postBinding = fixture.application.bindings.verifiedReceipt(session);
  const attemptId = randomUUID();
  const before = { ...counts };
  const result = await recover(deliveryId, text, { attemptId });
  if (result.recovery?.action !== "submitted-existing") {
    const safe = (receipt) =>
      receipt
        ? {
            pid: receipt.pid,
            pidStart: receipt.pidStart,
            providerSessionId: receipt.providerSessionId,
          }
        : null;
    console.error(
      "RECOVERY_BINDINGS",
      JSON.stringify({
        before: safe(preBinding),
        pasted: safe(postBinding),
        recovered: safe(fixture.application.bindings.verifiedReceipt(session)),
      }),
    );
  }
  assert.equal(result.recovery?.action, "submitted-existing", JSON.stringify(result));
  assert.equal(counts.paste - before.paste, 0);
  assert.equal(counts.submit - before.submit, 1);
  const after = { ...counts };
  assert.equal(
    (await recover(deliveryId, text, { attemptId })).recovery?.action,
    "submitted-existing",
  );
  assert.deepEqual(counts, after);
  for (let n = 0; n < 150; n++) {
    const screen = await snapshot();
    const composer = inspectChatComposer(session.tool, screen.raw, screen.pane);
    if (
      composer.state === "empty" &&
      screen.raw.includes(`Synthetic response complete: ${text}`)
    )
      break;
    if (n === 149) throw new Error("Recovered native message response was not observed");
    await sleep(20);
  }
  const editedText = "AP_PROBE_MANUAL_DRAFT";
  const editedId = await leaveDraft(editedText);
  await manager.tmux(["send-keys", "-t", target, "BSpace", "BSpace", "BSpace"]);
  await sleep(100);
  const editedScreen = await snapshot();
  const editedComposer = inspectChatComposer(
    session.tool,
    editedScreen.raw,
    editedScreen.pane,
  );
  assert.notEqual(editedComposer.text, editedText);
  const beforeBlocked = { ...counts };
  const blocked = await recover(editedId, editedText);
  assert.equal(blocked.recovery?.action, "blocked");
  assert.deepEqual(counts, beforeBlocked);
  const afterBlocked = await snapshot();
  assert.deepEqual(
    inspectChatComposer(session.tool, afterBlocked.raw, afterBlocked.pane),
    editedComposer,
  );
  const beforeFresh = { ...counts };
  const fresh = {
    deliveryId: randomUUID(),
    deliveryScope,
    text: " AP_PROBE_APPEND",
    submit: true,
  };
  const sendFresh = async () =>
    (
      await fixture.request(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: fresh,
      })
    ).json();
  assert.equal((await sendFresh()).status, "handed-off");
  assert.equal((await sendFresh()).status, "handed-off");
  assert.equal(counts.paste - beforeFresh.paste, 1);
  assert.equal(counts.submit - beforeFresh.submit, 1);
  for (let n = 0; n < 250; n++) {
    const screen = (await snapshot()).raw.replace(/\x1b\[[0-9;:]*m/g, "");
    if (
      screen.includes(`Synthetic response complete: AP_PROBE_APPEND`) &&
      screen.includes(editedComposer.text + fresh.text)
    )
      break;
    if (n === 249) throw new Error("Fresh chat input did not append to the native draft");
    await sleep(20);
  }
  return {
    submittedExisting: true,
    extraPaste: 0,
    submit: 1,
    recoveryReplayWrites: 0,
    manuallyEditedDraft: "blocked",
    blockedWrites: 0,
    freshInputAppended: true,
  };
}
