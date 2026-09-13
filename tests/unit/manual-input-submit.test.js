import test from "node:test";
import assert from "node:assert/strict";
import {
  recordManualInput,
  assertManualInputSettled,
} from "../../server/features/sessions/manual-input-guard.js";

function fixture(tool = "codex") {
  const manager = {
    pendingTerminalInput: new Set(),
    target: () => "isolated",
    // A collapsed or not-yet-rendered draft never proves its complete contents.
    tmux: async () => "2|0|120\nUnrecognized synthetic composer\n",
  };
  const session = { id: "isolated", tool };
  const state = {};
  return {
    write: (text) => recordManualInput(manager, session, text, state),
    blocked: () => manager.pendingTerminalInput.has(session.id),
    ready: () =>
      assertManualInputSettled(manager, session.id, { composer: { state: "empty" } }),
  };
}

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: submitting a collapsed draft releases the terminal render guard`, async () => {
    const x = fixture(tool);
    await x.write("\x1b[200~" + "Long synthetic draft\n".repeat(100) + "\x1b[201~");
    assert.throws(x.ready, { status: 409 });
    await x.write("\r");
    assert.doesNotThrow(x.ready);
  });

  test(`${tool}: a batched terminal prompt and Enter does not latch chat off`, async () => {
    const x = fixture(tool);
    await x.write("\x1b[200~synthetic prompt\x1b[201~\r");
    assert.doesNotThrow(x.ready);
    await x.write("another prompt\rnew unsent draft");
    assert.throws(x.ready, { status: 409 });
  });
}

test("pasted Enter and cancel bytes are data, even across input frames", async () => {
  const x = fixture();
  for (const part of ["\x1b[20", "0~draft\r\x03\x15", "\x1b[20", "1~"])
    await x.write(part);
  assert.throws(x.ready, { status: 409 });
  await x.write("\r");
  assert.doesNotThrow(x.ready);
});

test("explicit terminal cancellation and clearing release an unreadable draft", async () => {
  for (const clear of ["\x03", "\x15"]) {
    const x = fixture();
    await x.write("synthetic draft");
    await x.write(clear);
    assert.doesNotThrow(x.ready);
  }
});

test("fragmented terminal replies do not create phantom user input", async () => {
  for (const reply of [
    "\x1b]11;rgb:1010/1111/1515\x1b\\",
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1b[?1;2c\x1b[32;3R",
  ]) {
    for (let split = 1; split < reply.length; split++) {
      const x = fixture();
      await x.write(reply.slice(0, split));
      await x.write(reply.slice(split));
      assert.equal(x.blocked(), false, `Reply split at ${split}`);
      await x.write("draft");
      assert.equal(x.blocked(), true);
    }
  }
});

test("terminal reply contents cannot clear an outstanding draft", async () => {
  const x = fixture();
  await x.write("draft");
  for (const part of ["\x1b]11;ignored\r", "\x03\x15\x1b", "\\"]) await x.write(part);
  assert.throws(x.ready, { status: 409 });
});

test("Alt+Enter and modified Enter do not release an unsent draft", async () => {
  for (const enter of ["\x1b\r", "\x1b[13;2u", "\x1b[27;2;13~"]) {
    const x = fixture();
    await x.write("draft");
    for (const ch of enter) await x.write(ch);
    assert.throws(x.ready, { status: 409 });
  }
});
