import test from "node:test";
import assert from "node:assert/strict";
import {
  CdpInput,
  inputCalls,
  keyEvent,
  toViewport,
  validateInput,
} from "../../server/features/assistants/browser-input.js";

const metrics = { cssWidth: 1280, cssHeight: 800 };

test("pointer fractions map to the page's CSS pixels and stay inside it", () => {
  assert.deepEqual(toViewport({ x: 0.5, y: 0.25 }, metrics), { x: 640, y: 200 });
  assert.deepEqual(toViewport({ x: 1, y: 1 }, metrics), { x: 1279, y: 799 });
  assert.deepEqual(toViewport({ x: 0, y: 0 }, metrics), { x: 0, y: 0 });
  // Before the first frame there is nothing to map to.
  assert.equal(toViewport({ x: 0.5, y: 0.5 }, null), null);
  assert.equal(toViewport({ x: 0.5, y: 0.5 }, { cssWidth: 0, cssHeight: 10 }), null);
});

test("only well-formed input commands pass", () => {
  assert.deepEqual(
    validateInput({
      type: "pointer",
      action: "down",
      x: 0.1,
      y: 0.2,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }),
    {
      type: "pointer",
      action: "down",
      x: 0.1,
      y: 0.2,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    },
  );
  for (const bad of [
    null,
    { type: "pointer", action: "down", x: 1.5, y: 0 },
    { type: "pointer", action: "drag", x: 0, y: 0 },
    { type: "pointer", action: "down", x: 0, y: 0, button: "back" },
    { type: "pointer", action: "down", x: 0, y: 0, modifiers: 99 },
    { type: "key", action: "down", key: "" },
    { type: "key", action: "down", key: "a".repeat(40) },
    { type: "key", action: "press", key: "a" },
    { type: "text", text: "" },
    { type: "text", text: "x".repeat(4001) },
    { type: "script", code: "alert(1)" },
  ])
    assert.equal(validateInput(bad), null, JSON.stringify(bad));
  assert.deepEqual(validateInput({ type: "wheel", x: 0.5, y: 0.5, deltaY: 99999 }), {
    type: "wheel",
    x: 0.5,
    y: 0.5,
    deltaX: 0,
    deltaY: 2000,
    modifiers: 0,
  });
  // A paste is inserted text.
  assert.deepEqual(validateInput({ type: "paste", text: "Passwort" }), {
    type: "text",
    text: "Passwort",
  });
});

test("keys become CDP key events: characters with text, shortcuts and special keys raw", () => {
  assert.deepEqual(
    keyEvent({ action: "down", key: "a", code: "KeyA", text: "", modifiers: 0 }),
    {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 0,
      windowsVirtualKeyCode: 65,
      text: "a",
      unmodifiedText: "a",
    },
  );
  // Ctrl+A selects instead of typing an "a".
  assert.equal(
    keyEvent({ action: "down", key: "a", code: "KeyA", text: "", modifiers: 2 }).type,
    "rawKeyDown",
  );
  const enter = keyEvent({
    action: "down",
    key: "Enter",
    code: "Enter",
    text: "",
    modifiers: 0,
  });
  assert.equal(enter.windowsVirtualKeyCode, 13);
  // With text it must be keyDown: Chromium ignores the text of a rawKeyDown.
  assert.equal(enter.type, "keyDown");
  assert.equal(enter.text, "\r");
  for (const event of [
    enter,
    keyEvent({ action: "down", key: "a", code: "KeyA", modifiers: 0 }),
  ])
    assert.ok(event.type === "keyDown" || !event.text);
  assert.equal(
    keyEvent({
      action: "down",
      key: "ArrowDown",
      code: "ArrowDown",
      text: "",
      modifiers: 0,
    }).windowsVirtualKeyCode,
    40,
  );
  assert.deepEqual(
    keyEvent({ action: "up", key: "a", code: "KeyA", text: "", modifiers: 0 }),
    {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 0,
      windowsVirtualKeyCode: 65,
    },
  );
});

test("commands become the CDP calls for the shown tab", () => {
  const click = validateInput({
    type: "pointer",
    action: "down",
    x: 0.5,
    y: 0.5,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  assert.deepEqual(inputCalls(click, metrics), [
    [
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: 640,
        y: 400,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      },
    ],
  ]);
  assert.deepEqual(
    inputCalls(validateInput({ type: "wheel", x: 0, y: 0, deltaY: 120 }), metrics),
    [
      [
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: 120, modifiers: 0 },
      ],
    ],
  );
  assert.deepEqual(
    inputCalls(validateInput({ type: "text", text: "Grüße 日本" }), null),
    [["Input.insertText", { text: "Grüße 日本" }]],
  );
  assert.deepEqual(inputCalls(click, null), []);
});

test("the CDP channel connects only to its own loopback browser endpoint", async () => {
  const answer = (webSocketDebuggerUrl) => async () => ({
    json: async () => ({ webSocketDebuggerUrl }),
  });
  for (const url of [
    "ws://evil.example:4321/devtools/browser/x",
    "ws://127.0.0.1:9999/devtools/browser/x",
    "ws://127.0.0.1:4321/devtools/page/x",
    "wss://127.0.0.1:4321/devtools/browser/x",
  ])
    await assert.rejects(new CdpInput(4321, { fetch: answer(url) }).connect(), {
      message: "cdp endpoint",
    });
  // Handed back: nothing queued or new is sent any more.
  const channel = new CdpInput(4321, {
    fetch: answer("ws://127.0.0.1:4321/devtools/browser/x"),
  });
  channel.close();
  await assert.rejects(channel.dispatch("T", [["Input.insertText", { text: "x" }]]), {
    message: "closed",
  });
  await assert.rejects(channel.connect(), { message: "closed" });
});
