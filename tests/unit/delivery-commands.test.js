import test from "node:test";
import assert from "node:assert/strict";
import { unconfirmedCommand } from "../../server/features/chat/delivery-commands.js";

test("bash mode is an unconfirmed command for Claude and Codex", () => {
  assert.equal(unconfirmedCommand("claude", "!ls -la"), true);
  assert.equal(unconfirmedCommand("codex", "!pwd"), true);
});

test("listed local commands match per CLI, with arguments", () => {
  for (const name of [
    "cost",
    "status",
    "clear",
    "compact",
    "context",
    "help",
    "model",
    "config",
  ])
    assert.equal(unconfirmedCommand("claude", `/${name}`), true, name);
  for (const name of ["status", "compact", "model", "diff", "mention"])
    assert.equal(unconfirmedCommand("codex", `/${name}`), true, name);
  assert.equal(unconfirmedCommand("claude", "/model opus"), true);
  assert.equal(unconfirmedCommand("claude", "/COST"), true);
});

test("commands of the other CLI are not listed", () => {
  assert.equal(unconfirmedCommand("claude", "/diff"), false);
  assert.equal(unconfirmedCommand("codex", "/cost"), false);
});

test("normal text, custom skills and other tools are not commands", () => {
  assert.equal(unconfirmedCommand("claude", "hello"), false);
  assert.equal(unconfirmedCommand("claude", "please run /cost"), false);
  assert.equal(unconfirmedCommand("claude", "/my-skill"), false);
  assert.equal(unconfirmedCommand("claude", "/status\nmore"), false);
  assert.equal(unconfirmedCommand("claude", ""), false);
  assert.equal(unconfirmedCommand("opencode", "!ls"), false);
  assert.equal(unconfirmedCommand("opencode", "/status"), false);
});
