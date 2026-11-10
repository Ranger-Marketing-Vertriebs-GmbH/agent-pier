import test from "node:test";
import assert from "node:assert/strict";
import { lineReader } from "../../server/features/tools/mcp-swap-proxy.js";

test("lines split across chunks are joined once; blank lines are skipped", () => {
  const lines = [];
  const read = lineReader((line) => lines.push(line));
  read('{"a":');
  read("1");
  read('}\n{"b":2}\n\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  read(":3}\n");
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("a long line in many chunks costs one join", () => {
  const lines = [];
  const read = lineReader((line) => lines.push(line));
  for (let i = 0; i < 10000; i += 1) read("x");
  read("\n");
  assert.equal(lines[0].length, 10000);
});
