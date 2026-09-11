import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
import { chatTuiScreen, renderChatTuiScreen } from "../helpers/chat-tui-fixture.js";

async function fixture(t, tool, screen) {
  const f = await applicationFixture(t);
  const recorder = await createTuiInputRecorder(f, {
    screen: renderChatTuiScreen(screen || (await chatTuiScreen(tool))),
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
    const screen = JSON.parse(
      await fs.readFile(
        new URL(`../fixtures/tui-input/${tool}-draft-native.json`, import.meta.url),
        "utf8",
      ),
    );
    const x = await fixture(t, tool, screen);
    const text = "SYNTHETIC draft ünicode";
    const input = x.body(text);
    // Seed the durable boundary of a prior completed paste, using the actual
    // owned pane's generation and composer. The parser and writer remain real.
    const generation = await x.f.application.sessions.withChatInput(
      x.session.id,
      async (tx) => {
        assert.deepEqual(tx.composer, { state: "text", text });
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
