import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function prepareClaudeProbe({
  fixture,
  session,
  capture,
  keys,
  options,
  waitFor,
}) {
  const folder = options.includes("--folder-trust");
  const manager = fixture.application.sessions;
  const target = `${manager.target(session.id)}:0`;
  if (folder) await manager.tmux(["resize-window", "-t", target, "-x", "50", "-y", "35"]);
  const frame = await waitFor(capture, (screen) =>
    screen.includes("Yes, I trust this folder"),
  );
  let recovery;
  if (folder) {
    const reqs = await fixture.application.requests.list(session.id);
    const request = reqs.requests.find((r) => r.presentation === "claudeFolderTrust");
    assert.ok(request, frame.replaceAll(fixture.root, "<fixture>"));
    const deliveryId = randomUUID(),
      text = "AP_PROBE_FOLDER_TRUST";
    const deliveryScope = JSON.stringify([
      session.id,
      session.accountId,
      session.tool,
      session.createdAt || null,
    ]);
    const blocked = await fixture.request(`/api/sessions/${session.id}/input`, {
      method: "POST",
      body: { deliveryId, deliveryScope, text, submit: true },
    });
    assert.equal((await blocked.json()).status, "rejected");
    assert.equal(
      fixture.application.chatDelivery.read(
        fixture.application.chatDelivery.file(session.id, deliveryId),
      ).journal.phase,
      "reserved",
    );
    const result = await fixture.request(
      `/api/sessions/${session.id}/requests/${request.id}/answer`,
      { method: "POST", body: { choice: "trust", expectedRevision: request.revision } },
    );
    const answer = await result.json();
    if (result.status !== 200)
      console.error((await capture()).replaceAll(fixture.root, "<fixture>"));
    assert.equal(result.status, 200, JSON.stringify(answer));
    recovery = { deliveryId, deliveryScope, text };
    await manager.tmux(["resize-window", "-t", target, "-x", "120", "-y", "35"]);
  } else {
    await delay(750);
    await keys(...(/❯[^\n]*Yes, I trust/.test(frame) ? ["Enter"] : ["Down", "Enter"]));
  }
  const auth = await waitFor(
    capture,
    (screen) => screen.includes("custom API key") || screen.includes("for shortcuts"),
  );
  if (auth.includes("custom API key")) {
    await delay(750);
    await keys("Up", "Enter");
  }
  await waitFor(capture, (screen) => screen.includes("for shortcuts"));
  if (recovery) {
    const result = await fixture.request(
      `/api/sessions/${session.id}/input/${recovery.deliveryId}/recovery`,
      {
        method: "POST",
        body: {
          ...recovery,
          attemptId: randomUUID(),
          expectedAttemptId: recovery.deliveryId,
          mode: "retry",
        },
      },
    );
    const receipt = await result.json();
    assert.equal(receipt.status, "handed-off", JSON.stringify(receipt));
    await waitFor(capture, (screen) =>
      screen.includes("Synthetic response complete: AP_PROBE_FOLDER_TRUST"),
    );
    console.log(
      JSON.stringify({
        folderTrust: {
          nativeApproval: true,
          mobileWidth: 50,
          blockedBeforePaste: true,
          retriedOriginalMessage: true,
          accepted: true,
        },
      }),
    );
  }
}
