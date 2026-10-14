import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseProgram,
  npmPrograms,
} from "../../server/features/mcp-packages/program-select.js";

test("a string bin is named after the unscoped package", () => {
  assert.deepEqual(npmPrograms("@scope/server-x", "./dist/index.js"), [
    { name: "server-x", path: "dist/index.js" },
  ]);
});
test("escaping or absolute bin paths are dropped", () => {
  assert.deepEqual(npmPrograms("x", { a: "../../etc/x", b: "/bin/sh", c: "bin/c.js" }), [
    { name: "c", path: "bin/c.js" },
  ]);
});
test("choosing a program", () => {
  const two = [
    { name: "a", path: "a.js" },
    { name: "b", path: "b.js" },
  ];
  assert.deepEqual(chooseProgram([two[0]], undefined), two[0]);
  assert.deepEqual(chooseProgram(two, "b"), two[1]);
  assert.throws(() => chooseProgram(two, undefined), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
  assert.throws(() => chooseProgram(two, "z"), { code: "MCP_PACKAGE_PROGRAM_REQUIRED" });
  assert.throws(() => chooseProgram([], undefined), { code: "MCP_PACKAGE_NO_PROGRAM" });
});

test("names must start alphanumerically and backslash paths are normalised", () => {
  assert.deepEqual(
    npmPrograms("x", { ".": "a.js", "..": "b.js", ".hidden": "c.js" }),
    [],
  );
  assert.deepEqual(npmPrograms("x", { a: "bin\\a.js" }), [
    { name: "a", path: "bin/a.js" },
  ]);
  assert.deepEqual(npmPrograms("x", { a: "a/../../x" }), []);
});
