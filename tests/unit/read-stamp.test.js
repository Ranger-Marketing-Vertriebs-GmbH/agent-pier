import test from "node:test";
import assert from "node:assert/strict";
import {
  READ_INSTANCE_HEADER,
  READ_STAMP_HEADER,
  readStamp,
  readStampHeader,
} from "../../server/lib/read-stamp.js";
import { noteReadStamp, parseReadStamp, readBefore } from "../../web/lib/read-stamps.js";

test("read stamps rise strictly, even within one millisecond", () => {
  const first = readStamp(1000);
  const second = readStamp(1000);
  assert.ok(second > first);
  assert.ok(readStamp() > second);
});

test("a GET answer carries when its read began, a write's when it is sent", () => {
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
  // A write's answer is stamped as its headers go out, after the handler's read.
  const headers = {};
  const res = {
    headersSent: false,
    setHeader: (name, value) => (headers[name] = value),
    writeHead: () => "written",
  };
  readStampHeader({ instance: () => "hub-1" })({ method: "PUT" }, res, () => {});
  const before = readStamp();
  assert.equal(res.writeHead(200), "written");
  assert.ok(parseReadStamp(headers[READ_STAMP_HEADER]) > before);
  // It names the server instance whose clock the stamp is on.
  assert.equal(headers[READ_INSTANCE_HEADER], "hub-1");
  assert.equal(parseReadStamp("nonsense"), null);
  assert.equal(parseReadStamp(null), null);
});

test("a write's answer read before the last push does not replace it", () => {
  // The SSH dialog: a push said the tools are ready, a slow save answer says starting.
  const answer = noteReadStamp({ tools: { state: "starting" } }, 100);
  assert.equal(readBefore(answer, 200), true);
  assert.equal(readBefore(answer, 50), false);
  // Without stamps the answer shows, as before.
  assert.equal(readBefore({ tools: {} }, 200), false);
  assert.equal(readBefore(answer, null), false);
});
