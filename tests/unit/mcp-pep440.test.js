import test from "node:test";
import assert from "node:assert/strict";
import { comparePep440 } from "../../server/features/mcp-packages/pep440.js";

test("PEP 440 order: dev, pre, final, post; epochs and zero padding", () => {
  const ascending = [
    "1.0.dev1",
    "1.0a1.dev1",
    "1.0a1",
    "1.0a1.post1",
    "1.0a2",
    "1.0b1",
    "1.0rc1",
    "1.0",
    "1.0.post1.dev1",
    "1.0.post1",
    "1.0.1",
    "1.10",
    "1!0.1",
  ];
  const shuffled = [...ascending].reverse();
  assert.deepEqual(shuffled.sort(comparePep440), ascending);
  assert.equal(comparePep440("1.0", "1.0.0"), 0);
  assert.equal(comparePep440("1.0RC1", "1.0rc1"), 0);
  assert.equal(comparePep440("99999999999999999999.0", "99999999999999999998.0"), 1);
});
