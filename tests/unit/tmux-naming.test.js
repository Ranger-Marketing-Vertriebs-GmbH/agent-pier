import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionIdFromName,
  tmuxSocketPath,
} from "../../server/features/sessions/tmux-naming.js";

test("sessionIdFromName reads only agentpier session names", () => {
  assert.equal(sessionIdFromName("agentpier-x"), "x");
  assert.equal(sessionIdFromName("agentpier-a_b-1"), "a_b-1");
  const former = ["tu", "iui-x"].join("");
  assert.equal(sessionIdFromName(former), null);
});

test("sessionIdFromName rejects invalid ids", () => {
  for (const name of [
    "agentpier-",
    "agentpier--x",
    "agentpier-x y",
    "agentpier-x/../y",
    `agentpier-${"a".repeat(81)}`,
    "other-x",
    "",
    undefined,
  ])
    assert.equal(sessionIdFromName(name), null, String(name));
});

test("tmuxSocketPath is a private agentpier socket per data directory", () => {
  const uid = process.getuid?.() ?? "user";
  const pattern = new RegExp(`^/tmp/agentpier-${uid}-[0-9a-f]{24}/tmux\\.sock$`);
  assert.match(tmuxSocketPath("/data/one"), pattern);
  assert.equal(tmuxSocketPath("/data/one"), tmuxSocketPath("/data/one/"));
  assert.notEqual(tmuxSocketPath("/data/one"), tmuxSocketPath("/data/two"));
});
