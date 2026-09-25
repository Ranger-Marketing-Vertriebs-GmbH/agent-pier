import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { chatTuiScreen, nativeDraftScreen } from "../helpers/chat-tui-fixture.js";
import { withChatInput } from "../../server/features/sessions/session-chat-input.js";
import { SessionOperations } from "../../server/features/sessions/session-operations.js";

async function setup(
  t,
  tool,
  { crash, partial = false, imageOnly = false, ignoreText = false } = {},
) {
  const f = await applicationFixture(t);
  const files = [path.join(f.home, "one image.png"), path.join(f.home, "two image.png")];
  for (const file of files) await fs.writeFile(file, "synthetic model fixture");
  const screen = await chatTuiScreen(tool);
  const session = { id: "native-images", tool, accountId: "fixture", status: "running" };
  const scope = JSON.stringify([session.id, session.accountId, tool, null]);
  const operations = new SessionOperations(() => Promise.resolve());
  const state = { content: "", pastes: [], submitted: [], buffer: "", images: 0 };
  const manager = {
    chatInputTiming: { timeoutMs: 50 },
    replacing: new Set(),
    target: () => "=fixture",
    current: async () => session,
    serial: (fn, id) => operations.run(fn, id),
    tmux: async (args, options) => {
      if (args[0] === "display-message") {
        const frame = nativeDraftScreen(tool, screen, state.content);
        const { cursorX, cursorY, width, height } = frame.pane;
        const dimensions = [cursorX, cursorY, width, height].join("|");
        return (
          (args.includes("#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}")
            ? dimensions
            : `%1|${process.pid}|1|${dimensions}|0`) +
          "\n" +
          frame.raw
        );
      }
      if (args[0] === "load-buffer") state.buffer = options.input;
      if (args[0] === "paste-buffer") {
        state.pastes.push(state.buffer);
        const file = state.buffer.startsWith('"')
          ? JSON.parse(state.buffer)
          : state.buffer;
        state.content += files.includes(file)
          ? `[Image ${tool === "codex" ? "#" : ""}${++state.images}] `
          : ignoreText
            ? ""
            : state.buffer;
        if (partial && state.pastes.length === 1)
          throw Error("Stopped during partial image batch");
      }
      if (args[0] === "send-keys" && args.at(-1) === "Enter") {
        state.submitted.push(state.content);
        state.content = "";
        state.images = 0;
      }
      return "";
    },
  };
  f.application.sessions.get = async () => session;
  f.application.sessions.withChatInput = (id, fn) => withChatInput(manager, id, fn);
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  const delivery = f.application.chatDelivery;
  const write = delivery.write.bind(delivery);
  let stopped = false;
  delivery.write = (file, receipt) => {
    write(file, receipt);
    if (!stopped && receipt.journal?.phase === crash) {
      stopped = true;
      throw Error("Stopped at durable image phase");
    }
  };
  const text = [...(imageOnly ? [] : ["Describe"]), ...files].join("\n");
  const deliveryId = randomUUID();
  const endpoint = `/api/sessions/${session.id}/input`;
  const post = async (url, body) =>
    (await f.request(url, { method: "POST", body })).json();
  return {
    state,
    files: tool === "codex" ? files.map((file) => JSON.stringify(file)) : files,
    send: () => post(endpoint, { deliveryId, deliveryScope: scope, text, submit: true }),
    recover: () =>
      post(`${endpoint}/${deliveryId}/recovery`, {
        attemptId: randomUUID(),
        expectedAttemptId: deliveryId,
        deliveryScope: scope,
        text,
        mode: "retry",
      }),
  };
}

for (const tool of ["codex", "opencode"]) {
  test(`${tool}: images use individual path pastes before text and one Enter`, async (t) => {
    const x = await setup(t, tool);
    assert.equal((await x.send()).status, "handed-off");
    assert.deepEqual(x.state.pastes, [...x.files, "Describe"]);
    assert.equal(x.state.submitted.length, 1);
    assert.equal((await x.send()).status, "handed-off");
    assert.equal(x.state.submitted.length, 1);
  });
  for (const crash of ["images-pasted", "pasted"])
    test(`${tool}: recovery after ${crash} never repastes images`, async (t) => {
      const x = await setup(t, tool, { crash });
      assert.equal((await x.send()).status, "uncertain");
      const recovered = await x.recover();
      assert.equal(recovered.status, "handed-off", JSON.stringify(recovered));
      assert.deepEqual(x.state.pastes, [...x.files, "Describe"]);
      assert.equal(x.state.submitted.length, 1);
    });
  test(`${tool}: text lost after image chips is never submitted`, async (t) => {
    const x = await setup(t, tool, { ignoreText: true });
    const result = await x.send();
    assert.equal(result.status, "uncertain");
    assert.equal(result.reason, "CHAT_SUBMIT_UNCONFIRMED");
    assert.equal(x.state.submitted.length, 0);
  });
  test(`${tool}: partial image batch stays uncertain and cannot be replayed`, async (t) => {
    const x = await setup(t, tool, { partial: true });
    assert.equal((await x.send()).status, "uncertain");
    assert.equal((await x.recover()).recovery.action, "blocked");
    assert.deepEqual(x.state.pastes, [x.files[0]]);
    assert.equal(x.state.submitted.length, 0);
  });
  test(`${tool}: image-only message submits its chips without an empty text paste`, async (t) => {
    const x = await setup(t, tool, { imageOnly: true });
    assert.equal((await x.send()).status, "handed-off");
    assert.deepEqual(x.state.pastes, x.files);
    assert.equal(x.state.submitted.length, 1);
  });
}
