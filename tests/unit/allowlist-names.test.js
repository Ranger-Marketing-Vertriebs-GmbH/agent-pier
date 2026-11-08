import test from "node:test";
import assert from "node:assert/strict";
import { commandName } from "../../web/features/assistants/settings/allowlist-names.js";

test("a command is named on one line", () => {
  assert.equal(
    commandName("cat <<EOF\n  hello\tworld\nEOF\n"),
    "cat <<EOF hello world EOF",
  );
  assert.equal(commandName("node build.js"), "node build.js");
});

test("a long command is cut by code points, never inside a surrogate pair", () => {
  const long = `${"a".repeat(78)}😀😀😀`;
  const name = commandName(long);
  assert.equal(name, `${"a".repeat(78)}😀…`);
  assert.equal(Array.from(name).length, 80);
  assert.equal(commandName("x".repeat(80)), "x".repeat(80));
  assert.equal(commandName("x".repeat(81)), `${"x".repeat(79)}…`);
});
