import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Called only inside the disposable native chat probe. No real user credentials. */
export async function probeCodexHookTrust({ fixture, session, capture, keys }) {
  const requests = fixture.application.requests;
  const manager = fixture.application.sessions;
  await manager.tmux([
    "resize-window",
    "-t",
    `${manager.target(session.id)}:0`,
    "-x",
    "50",
    "-y",
    "35",
  ]);
  const deadline = Date.now() + 15000;
  let pending;
  while (Date.now() < deadline) {
    if ((await capture()).includes("Yes, continue")) {
      await delay(750);
      await keys("Enter");
    }
    pending = (await requests.list(session.id)).requests.find(
      (r) => r.presentation === "codexHookTrust",
    );
    if (pending && (await capture()).includes("Trust all and continue")) break;
    await delay(50);
  }
  if (!pending) console.error((await capture()).replaceAll(fixture.root, "<fixture>"));
  assert.ok(pending, "Native hooks/list must publish a startup approval in Chat");
  const text = "AP_PROBE_HOOK_TRUST",
    deliveryId = randomUUID();
  const deliveryScope = JSON.stringify([
    session.id,
    session.accountId,
    session.tool,
    session.createdAt || null,
  ]);
  const send = await fixture.request(`/api/sessions/${session.id}/input`, {
    method: "POST",
    body: { deliveryId, deliveryScope, text, submit: true },
  });
  const rejected = await send.json();
  assert.equal(rejected.status, "rejected");
  assert.equal(
    fixture.application.chatDelivery.read(
      fixture.application.chatDelivery.file(session.id, deliveryId),
    ).journal.phase,
    "reserved",
  );
  const approvalScreen = await capture();
  const approval = await fixture.request(
    `/api/sessions/${session.id}/requests/${pending.id}/answer`,
    { method: "POST", body: { choice: "trust", expectedRevision: pending.revision } },
  );
  if (approval.status !== 200) console.error(approvalScreen, await capture());
  assert.equal(approval.status, 200, JSON.stringify(await approval.json()));
  const config = parse(
    await fs.readFile(path.join(fixture.home, "codex/config.toml"), "utf8"),
  );
  assert.ok(
    Object.values(config.hooks.state).filter((value) => value.trusted_hash).length >=
      pending.hookCount,
  );
  await manager.tmux([
    "resize-window",
    "-t",
    `${manager.target(session.id)}:0`,
    "-x",
    "120",
    "-y",
    "35",
  ]);
  const ready = Date.now() + 10000;
  while (Date.now() < ready && !(await capture()).includes("Ask Codex to do anything"))
    await delay(50);
  const retry = await fixture.request(
    `/api/sessions/${session.id}/input/${deliveryId}/recovery`,
    {
      method: "POST",
      body: {
        attemptId: randomUUID(),
        expectedAttemptId: deliveryId,
        deliveryScope,
        text,
        mode: "retry",
      },
    },
  );
  const result = await retry.json();
  assert.equal(result.status, "handed-off", JSON.stringify(result));
  const accepted = Date.now() + 15000;
  while (
    Date.now() < accepted &&
    !(await capture()).includes("Synthetic response complete: AP_PROBE_HOOK_TRUST")
  )
    await delay(50);
  assert.ok(
    (await capture()).includes("Synthetic response complete: AP_PROBE_HOOK_TRUST"),
  );
  console.log(
    JSON.stringify({
      hookTrust: {
        nativeApproval: true,
        mobileWidth: 50,
        trustPersisted: true,
        blockedBeforePaste: true,
        retriedOriginalMessage: true,
        accepted: true,
      },
    }),
  );
}
