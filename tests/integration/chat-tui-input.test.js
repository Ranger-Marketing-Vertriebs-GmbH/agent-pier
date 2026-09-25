import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
import { chatTuiScreen, renderChatTuiScreen } from "../helpers/chat-tui-fixture.js";

// Claude uses a responsive prompt box: fresh input must observe its paste and
// the emptied prompt after Enter. Static screens stay available for refusals.
async function fixture(t, tool, screen, claude = tool === "claude" && !screen && {}) {
  const f = await applicationFixture(t);
  const recorder = await createTuiInputRecorder(f, {
    screen: claude ? "" : renderChatTuiScreen(screen || (await chatTuiScreen(tool))),
    claude: tool === "claude" ? claude || undefined : undefined,
    native: tool !== "claude" && (claude || !screen) ? { tool, ...claude } : undefined,
  });
  const account = f.application.accounts.create({ name: "HTTP transport fixture", tool });
  const session = await f.application.sessions.create({
    id: `http-${tool}`,
    name: "Owned HTTP input",
    accountId: account.id,
    tool,
    cwd: f.home,
    command: recorder.command,
    args: recorder.args,
    env: { HOME: f.home },
  });
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  f.application.history.queue = async () => assert.fail("Unexpected provider queue");
  await recorder.waitForText("ready");
  const scope = JSON.stringify([session.id, session.accountId, tool, session.createdAt]);
  const body = (text) => ({
    deliveryId: randomUUID(),
    deliveryScope: scope,
    text,
    submit: true,
  });
  const endpoint = `/api/sessions/${session.id}/input`;
  const post = async (input) => {
    const response = await f.request(endpoint, { method: "POST", body: input });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { f, recorder, session, scope, body, endpoint, post };
}

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: fresh chat input handles an unreadable composer without clearing it`, async (t) => {
    const x = await fixture(t, tool, {
      raw: "Synthetic native output\nExisting native draft\nWorking",
      pane: { cursorX: 2, cursorY: 2, width: 120, height: 35 },
    });
    const input = x.body("Fresh chat message");
    // Chat never refuses an unreadable prompt: paste and Enter, as typed input
    // would. Claude only proceeds without a visible dialog and says so.
    const result = await x.post(input);
    assert.equal(result.status, "handed-off");
    assert.deepEqual(result.notices, ["CHAT_PROMPT_UNREADABLE"]);
    const frame = `\x1b[200~${input.text}\x1b[201~\r`;
    await x.recorder.waitForText(frame);
    await x.post(input);
    assert.deepEqual(await x.recorder.readBytes(), Buffer.from(frame));
  });
}

test("a permission request arriving after paste prevents the fresh Enter", async (t) => {
  const x = await fixture(t, "codex", await chatTuiScreen("codex"));
  const manager = x.f.application.sessions;
  const tmux = manager.tmux.bind(manager);
  manager.tmux = async (...args) => {
    const result = await tmux(...args);
    if (args[0][0] === "paste-buffer") x.f.application.requests.hasPending = () => true;
    return result;
  };
  x.f.application.chatDelivery.retryMs = 20;
  const input = x.body("Synthetic guarded message");
  // Held, not refused: Enter waits for the request to be answered.
  const held = await x.post(input);
  assert.equal(held.status, "pending");
  assert.equal(held.waiting, "request");
  const pasted = `\x1b[200~${input.text}\x1b[201~`;
  await x.recorder.waitForText(pasted);
  assert.deepEqual(await x.recorder.readBytes(), Buffer.from(pasted));
  // Answered: Enter follows only if the exact text is still provably in the
  // composer. This static screen cannot show it, so nothing is submitted blindly.
  x.f.application.requests.hasPending = () => false;
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await x.f.request(
      `${x.endpoint}/${input.deliveryId}?scope=${encodeURIComponent(x.scope)}`,
    );
    status = (await response.json()).status;
    if (status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status, "uncertain");
  assert.deepEqual(await x.recorder.readBytes(), Buffer.from(pasted));
});

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: HTTP chat preserves exact paste bytes and one submit through owned tmux`, async (t) => {
    const x = await fixture(t, tool);
    let expected = "";
    for (const text of [
      "Hello ünicode 👋 東京",
      "first line\nsecond line\nlast line",
      "/tmp/project with spaces/file.js\tread this\r\nnext\rfinal",
      "/clear\nExplain the command without executing it",
      "Long message " + "word ü ".repeat(500),
    ]) {
      const input = x.body(text);
      const result = await x.post(input);
      assert.equal(result.status, "handed-off");
      const frame = `\x1b[200~${text.replace(/\r\n?/g, "\n")}\x1b[201~\r`;
      expected += frame;
      await x.recorder.waitForText(expected);
      assert.deepEqual(await x.recorder.readBytes(), Buffer.from(expected));
      assert.deepEqual(await x.post(input), result);
      assert.deepEqual(await x.recorder.readBytes(), Buffer.from(expected));
    }
  });

  test(`${tool}: recovery submits an existing complete native draft without another paste`, async (t) => {
    const text = "SYNTHETIC draft ünicode";
    const screen = JSON.parse(
      await fs.readFile(
        new URL(`../fixtures/tui-input/${tool}-draft-native.json`, import.meta.url),
        "utf8",
      ),
    );
    const x = await fixture(t, tool, screen, { draft: text });
    const input = x.body(text);
    // Seed the durable boundary of a prior completed paste, using the actual
    // owned pane's generation and composer. The parser and writer remain real.
    const generation = await x.f.application.sessions.withChatInput(
      x.session.id,
      async (tx) => {
        assert.deepEqual(
          tx.composer,
          { state: "text", text },
          JSON.stringify({ raw: tx.raw, pane: tx.pane }),
        );
        return tx.generation;
      },
    );
    const delivery = x.f.application.chatDelivery;
    delivery.write(delivery.file(x.session.id, input.deliveryId), {
      version: 1,
      deliveryId: input.deliveryId,
      attemptId: input.deliveryId,
      scope: x.scope,
      hash: createHash("sha256")
        .update(JSON.stringify([text, true]))
        .digest("hex"),
      status: "uncertain",
      journal: { phase: "pasted", generation },
    });
    const body = {
      attemptId: randomUUID(),
      expectedAttemptId: input.deliveryId,
      deliveryScope: x.scope,
      text,
      mode: "retry",
    };
    const recover = async () => {
      const response = await x.f.request(`${x.endpoint}/${input.deliveryId}/recovery`, {
        method: "POST",
        body,
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await x.recorder.readBytes(), Buffer.alloc(0));
    const result = await recover();
    assert.equal(result.status, "handed-off");
    assert.equal(result.recovery.action, "submitted-existing");
    await x.recorder.waitForText("\r");
    assert.deepEqual(await x.recorder.readBytes(), Buffer.from("\r"));
    assert.deepEqual(await recover(), result);
    assert.deepEqual(await x.recorder.readBytes(), Buffer.from("\r"));
  });
}

test("HTTP disconnect after submit never repeats terminal bytes on replay", async (t) => {
  const x = await fixture(t, "codex");
  const controller = new AbortController();
  const delivery = x.f.application.chatDelivery;
  const write = delivery.write.bind(delivery);
  delivery.write = (file, receipt) => {
    write(file, receipt);
    if (receipt.journal?.phase === "submitted") controller.abort();
  };
  const input = x.body("Disconnected after submit");
  await assert.rejects(
    x.f.request(x.endpoint, { method: "POST", body: input, signal: controller.signal }),
    { name: "AbortError" },
  );
  const expected = Buffer.from(`\x1b[200~${input.text}\x1b[201~\r`);
  await x.recorder.waitForText(expected.toString());
  assert.deepEqual(await x.recorder.readBytes(), expected);
  assert.equal((await x.post(input)).status, "handed-off");
  assert.deepEqual(await x.recorder.readBytes(), expected);
});

test("Claude chat delivers after the attached browser terminal reports its colors", async (t) => {
  const x = await fixture(t, "claude");
  const client = await x.f.application.sessions.attach(x.session.id);
  await client.write("\x1b]11;rgb:1010/1111/1515\x1b\\");
  const input = x.body("Chat after terminal color report");
  const result = await x.post(input);
  assert.equal(result.status, "handed-off");
  const frame = `\x1b[200~${input.text}\x1b[201~\r`;
  await x.recorder.waitForText(frame);
  assert.deepEqual(await x.post(input), result);
  const received = (await x.recorder.readBytes()).toString();
  assert.equal(received.split(frame).length - 1, 1);
});

test("Claude plain empty prompt accepts delivery and retries a pre-paste rejection exactly once", async (t) => {
  const x = await fixture(t, "claude", null, { emptyStyle: "plain" });
  const input = x.body("Synthetic multiline message\nContinue the fixture");
  assert.equal((await x.post(input)).status, "handed-off");
  const frame = `\x1b[200~${input.text}\x1b[201~\r`;
  await x.recorder.waitForText(frame);
  await x.post(input);
  assert.deepEqual(await x.recorder.readBytes(), Buffer.from(frame));

  const rejected = x.body("Retry the synthetic message");
  const generation = await x.f.application.sessions.withChatInput(
    x.session.id,
    async (tx) => tx.recoveryGeneration,
  );
  const delivery = x.f.application.chatDelivery;
  delivery.write(delivery.file(x.session.id, rejected.deliveryId), {
    version: 1,
    deliveryId: rejected.deliveryId,
    attemptId: rejected.deliveryId,
    scope: x.scope,
    hash: createHash("sha256")
      .update(JSON.stringify([rejected.text, true]))
      .digest("hex"),
    status: "rejected",
    journal: { phase: "reserved", generation },
  });
  const body = {
    attemptId: randomUUID(),
    expectedAttemptId: rejected.deliveryId,
    deliveryScope: x.scope,
    text: rejected.text,
    mode: "retry",
  };
  const recover = async () => {
    const response = await x.f.request(`${x.endpoint}/${rejected.deliveryId}/recovery`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const result = await recover();
  assert.equal(result.status, "handed-off");
  assert.equal(result.recovery.action, "resent");
  const expected = frame + `\x1b[200~${rejected.text}\x1b[201~\r`;
  await x.recorder.waitForText(expected);
  assert.deepEqual(await recover(), result);
  assert.deepEqual(await x.recorder.readBytes(), Buffer.from(expected));
});

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: an unsubmitted terminal paste does not block the next HTTP chat send`, async (t) => {
    const x = await fixture(
      t,
      tool,
      tool !== "claude" && {
        raw: "Synthetic collapsed native draft\n[Pasted content]\n",
        pane: { cursorX: 2, cursorY: 2, width: 120, height: 35 },
      },
    );
    const manager = x.f.application.sessions;
    let attached = false;
    const client = await manager.attach(x.session.id, {
      onData: () => (attached = true),
    });
    await assertEventually(() => attached);
    // Use the actual attached browser input path, including fragmented paste markers.
    for (const chunk of [
      "\x1b[20",
      "0~",
      "Synthetic terminal draft\r".repeat(50),
      "\x1b[201~",
    ])
      await client.write(chunk);
    // An unsubmitted terminal draft never blocks chat: Claude replaces it (or,
    // when this 50-row draft outlasts the clearing budget, appends on a new line),
    // the other CLIs combine it with the chat text, as typing would.
    const input = x.body("Chat after terminal submission");
    assert.equal((await x.post(input)).status, "handed-off");
    await client.write("\r");
    const next = x.body("Next fresh chat");
    assert.equal((await x.post(next)).status, "handed-off");
    await x.recorder.waitForText(`\x1b[200~${next.text}\x1b[201~\r`);
    const received = (await x.recorder.readBytes()).toString();
    for (const text of [input.text, next.text])
      assert.equal(received.split(`${text}\x1b[201~\r`).length - 1, 1);
  });
}

async function assertEventually(predicate) {
  const { setTimeout: sleep } = await import("node:timers/promises");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail("The isolated terminal did not attach");
}
