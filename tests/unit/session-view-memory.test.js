import test from "node:test";
import assert from "node:assert/strict";
import { SessionViewMemory } from "../../web/app/session-view-memory.js";
const first = { id: "first", tool: "codex", createdAt: "today" };
const second = { id: "second", tool: "claude" };

test("session views survive switching and reload while new sessions inherit the coding view", () => {
  let value;
  const storage = () => ({
    getItem: () => value,
    setItem: (_, next) => {
      value = next;
    },
  });
  const memory = new SessionViewMemory(storage);
  assert.equal(memory.mode(first, false), "terminal");
  assert.equal(memory.mode(first, true), "reader");
  memory.remember(first, "reader");
  assert.equal(memory.mode(second, false), "reader");
  memory.remember(second, "terminal");
  assert.equal(memory.mode(first, false), "reader");
  memory.remember(first, "files");
  const restored = new SessionViewMemory(storage);
  assert.equal(restored.mode(first, false), "files");
  assert.equal(restored.mode(second, true), "terminal");
  assert.equal(restored.mode({ ...first, createdAt: "tomorrow" }, false), "terminal");
});

test("shell and login sessions cannot inherit chat or change the coding preference", () => {
  const memory = new SessionViewMemory(() => null);
  memory.remember(first, "reader");
  for (const session of [
    { id: "shell", tool: "shell" },
    { id: "login", tool: "claude", purpose: "login" },
  ]) {
    assert.equal(memory.mode(session, true), "terminal");
    memory.remember(session, "terminal");
    assert.equal(memory.mode(second, false), "reader");
  }
});

test("unavailable or corrupt storage does not break view memory", () => {
  for (const storage of [
    () => {
      throw Error("Denied");
    },
    () => ({ getItem: () => "{invalid" }),
  ]) {
    const memory = new SessionViewMemory(storage);
    memory.remember(first, "reader");
    assert.equal(memory.mode(first, false), "reader");
  }
});
