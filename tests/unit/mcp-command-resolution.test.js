import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommand,
  sanitisedPrefix,
} from "../../server/features/mcp-servers/command-resolution.js";

const files = new Set(["/opt/bin/tool", "/usr/bin/other", "/abs/server"]);
const exists = (file) => files.has(file);

test("bare commands resolve against the given PATH in order", () => {
  assert.equal(
    resolveCommand("tool", { pathEnv: "/nope:/opt/bin:/usr/bin", exists }),
    "/opt/bin/tool",
  );
});
test("absolute commands are kept as entered when they exist", () => {
  assert.equal(resolveCommand("/abs/server", { pathEnv: "", exists }), "/abs/server");
  assert.throws(() => resolveCommand("/abs/missing", { exists }), { status: 400 });
});
test("unresolvable, relative-path and empty commands are rejected", () => {
  for (const command of ["missing", "./tool", "bin/tool", "", "  ", 5, "a\nb"])
    assert.throws(() => resolveCommand(command, { pathEnv: "/opt/bin", exists }), {
      status: 400,
    });
});
test("relative PATH entries are ignored", () => {
  assert.throws(() => resolveCommand("tool", { pathEnv: "opt/bin", exists }), {
    status: 400,
  });
});
test("the tool prefix equals the validated name", () => {
  assert.equal(sanitisedPrefix("My_server-1"), "My_server-1");
  for (const bad of ["a.b", "a".repeat(31), "1abc", "", "a b", "_x", null])
    assert.throws(() => sanitisedPrefix(bad), { status: 400 });
  assert.equal(sanitisedPrefix("a".repeat(30)).length, 30);
});
