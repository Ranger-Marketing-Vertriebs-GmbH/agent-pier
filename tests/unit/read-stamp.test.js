import test from "node:test";
import assert from "node:assert/strict";
import {
  READ_STAMP_HEADER,
  readStamp,
  readStampHeader,
} from "../../server/lib/read-stamp.js";
import { parseReadStamp } from "../../web/lib/read-stamps.js";

test("read stamps rise strictly, even within one millisecond", () => {
  const first = readStamp(1000);
  const second = readStamp(1000);
  assert.ok(second > first);
  assert.ok(readStamp() > second);
});

test("every GET answer carries when its read began, writes none", () => {
  const stamped = (method) => {
    const headers = {};
    let passed = false;
    readStampHeader()(
      { method },
      { setHeader: (name, value) => (headers[name] = value) },
      () => (passed = true),
    );
    assert.ok(passed);
    return headers[READ_STAMP_HEADER];
  };
  const first = parseReadStamp(stamped("GET"));
  assert.ok(first > 0);
  assert.ok(parseReadStamp(stamped("GET")) > first);
  assert.equal(stamped("POST"), undefined);
  assert.equal(parseReadStamp("nonsense"), null);
  assert.equal(parseReadStamp(null), null);
});
