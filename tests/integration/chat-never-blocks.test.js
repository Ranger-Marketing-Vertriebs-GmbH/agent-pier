import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";

// Owned tmux and a synthetic Claude prompt box: chat must reach the TUI even when
// the terminal holds a draft that cannot be cleared or shows a native dialog.
async function fixture(t, claude, size) {
  const f = await applicationFixture(t);
  const recorder = await createTuiInputRecorder(f, { claude });
  const account = f.application.accounts.create({ name: "Never blocks", tool: "claude" });
  const session = await f.application.sessions.create({
    id: "never-blocks",
    name: "Owned Claude input",
    accountId: account.id,
    tool: "claude",
    cwd: f.home,
    command: recorder.command,
    args: recorder.args,
    env: { HOME: f.home },
  });
  const manager = f.application.sessions;
  manager.chatInputTiming = { clear: { settleMs: 150, timeoutMs: 1500 } };
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  await recorder.waitForText("ready");
  if (size) {
    const target = `${manager.target(session.id)}:0.0`;
    await manager.tmux(["resize-window", "-t", target, "-x", size[0], "-y", size[1]]);
    await sleep(200);
  }
  const scope = JSON.stringify([
    session.id,
    session.accountId,
    "claude",
    session.createdAt,
  ]);
  const post = async (text) => {
    const response = await f.request(`/api/sessions/${session.id}/input`, {
      method: "POST",
      body: { deliveryId: randomUUID(), deliveryScope: scope, text, submit: true },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const status = async (deliveryId) =>
    (
      await f.request(
        `/api/sessions/${session.id}/input/${deliveryId}?scope=${encodeURIComponent(scope)}`,
      )
    ).json();
  return { f, recorder, session, manager, post, status };
}

test("regression: a typed draft that cannot be cleared at 50x34 is sent along", async (t) => {
  const x = await fixture(t, { ignoreEditing: true }, ["50", "34"]);
  let attached = false;
  const client = await x.manager.attach(x.session.id, {
    onData: () => (attached = true),
  });
  for (let attempt = 0; !attached && attempt < 100; attempt++) await sleep(20);
  // Typed in the terminal and not yet submitted.
  await client.write("half-typed idea");
  await x.recorder.waitForText("half-typed idea");
  const result = await x.post("please also check the tests");
  assert.equal(result.status, "handed-off");
  assert.deepEqual(result.notices, ["CHAT_APPENDED_TO_DRAFT"]);
  const paste = "\x1b[200~\nplease also check the tests\x1b[201~\r";
  await x.recorder.waitForText(paste);
  const bytes = (await x.recorder.readBytes()).toString();
  assert.equal(bytes.split(paste).length - 1, 1);
  // Clearing attempts never use Escape or Ctrl-C.
  assert.ok(!/\x03|\x1b(?![[])/.test(bytes.split(paste)[0]));
});

test("an open Claude menu is closed with Escape before the message is sent", async (t) => {
  const x = await fixture(t, { dialog: "menu" });
  const result = await x.post("message after the menu");
  assert.equal(result.status, "handed-off");
  assert.deepEqual(result.notices, ["CHAT_DIALOG_CLOSED"]);
  const paste = "\x1b[200~message after the menu\x1b[201~\r";
  await x.recorder.waitForText(paste);
  // One Escape, then the paste and a single Enter: nothing confirmed the menu.
  assert.equal((await x.recorder.readBytes()).toString(), `\x1b${paste}`);
});

test("a native question in the TUI holds the message until it is answered", async (t) => {
  const x = await fixture(t, { dialog: "question" });
  x.f.application.chatDelivery.retryMs = 50;
  const held = await x.post("message after the answer");
  assert.equal(held.status, "pending");
  assert.equal(held.waiting, "dialog");
  await sleep(300);
  // Never Escape (it would deny) and never Enter into the question.
  assert.equal((await x.recorder.readBytes()).length, 0);
  // The user answers in the terminal.
  const client = await x.manager.attach(x.session.id, { onData: () => {} });
  await sleep(100);
  await client.write("\r");
  const paste = "\x1b[200~message after the answer\x1b[201~\r";
  await x.recorder.waitForText(paste);
  assert.equal((await x.recorder.readBytes()).toString(), `\r${paste}`);
  let status;
  for (let attempt = 0; attempt < 100 && status !== "handed-off"; attempt++) {
    status = (await x.status(held.deliveryId)).status;
    await sleep(20);
  }
  assert.equal(status, "handed-off");
});
