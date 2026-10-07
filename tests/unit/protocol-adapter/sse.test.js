import test from "node:test";
import assert from "node:assert/strict";
import {
  createSseParser,
  sseComment,
  sseData,
  sseEvent,
} from "../../../server/features/protocol-adapter/sse.js";

const parseAll = (text, options) => {
  const parser = createSseParser(options);
  return [...parser.push(text), ...parser.end()];
};

test("parses named events and joins multi-line data", () => {
  assert.deepEqual(parseAll("event: a\ndata: one\ndata: two\nid: 7\n\ndata:x\n\n"), [
    { event: "a", data: "one\ntwo", id: "7" },
    { event: undefined, data: "x", id: undefined },
  ]);
});

test("accepts CRLF, LF and lone CR terminators, also split across chunks", () => {
  const expected = [
    { event: "e", data: "a", id: undefined },
    { event: undefined, data: "b", id: undefined },
  ];
  assert.deepEqual(parseAll("event: e\r\ndata: a\r\n\r\ndata: b\r\n\r\n"), expected);
  assert.deepEqual(parseAll("event: e\rdata: a\r\rdata: b\r\r"), expected);
  const parser = createSseParser();
  const events = [
    ...parser.push("event: e\r"),
    ...parser.push("\ndata: a\r"),
    ...parser.push("\n\r"),
    ...parser.push("\ndata: b\n\n"),
    ...parser.end(),
  ];
  assert.deepEqual(events, expected);
});

test("ignores comments and retry, keeps [DONE] as data", () => {
  assert.deepEqual(parseAll(": keep-alive\nretry: 100\ndata: [DONE]\n\n"), [
    { event: undefined, data: "[DONE]", id: undefined },
  ]);
});

test("a block without data is dropped, an explicit empty data line is kept", () => {
  assert.deepEqual(parseAll("event: ping\n\nid: 1\n\n"), []);
  assert.deepEqual(parseAll("event: ping\ndata:\n\n"), [
    { event: "ping", data: "", id: undefined },
  ]);
});

test("a leading BOM is ignored", () => {
  assert.deepEqual(parseAll("﻿data: x\n\n"), [
    { event: undefined, data: "x", id: undefined },
  ]);
  const parser = createSseParser();
  assert.deepEqual(parser.push("﻿"), []);
  assert.deepEqual(parser.push("data: y\n\n"), [
    { event: undefined, data: "y", id: undefined },
  ]);
});

test("end flushes a trailing event without blank line", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push("data: tail"), []);
  assert.deepEqual(parser.end(), [{ event: undefined, data: "tail", id: undefined }]);
  assert.deepEqual(parser.end(), []);
});

test("enforces maxEventBytes", () => {
  assert.throws(() => parseAll("data: 0123456789\n\n", { maxEventBytes: 8 }), {
    name: "RangeError",
    message: "sseEventTooLarge",
  });
  const parser = createSseParser({ maxEventBytes: 8 });
  assert.throws(() => parser.push("data: 0123456789"), RangeError);
  assert.equal(parseAll("data: 1234\n\n", { maxEventBytes: 8 }).length, 1);
});

test("writers produce well-formed frames that the parser reads back", () => {
  assert.equal(sseData({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(sseData("[DONE]"), "data: [DONE]\n\n");
  assert.equal(sseEvent("x", { b: 2 }), 'event: x\ndata: {"b":2}\n\n');
  assert.equal(sseComment("hi"), ": hi\n\n");
  assert.equal(sseComment("a\nb"), ": a\n: b\n\n");
  assert.deepEqual(
    parseAll(sseEvent("x", { b: 2 }) + sseData("[DONE]") + sseComment("c")),
    [
      { event: "x", data: '{"b":2}', id: undefined },
      { event: undefined, data: "[DONE]", id: undefined },
    ],
  );
});

test("id and retry lines count toward maxEventBytes", () => {
  assert.throws(() => parseAll("id: 0123456789\ndata: x\n\n", { maxEventBytes: 8 }), {
    message: "sseEventTooLarge",
  });
  assert.throws(() => parseAll("retry: 0123456789\ndata: x\n\n", { maxEventBytes: 8 }), {
    message: "sseEventTooLarge",
  });
  assert.equal(parseAll("id: 1\nretry: 2\ndata: x\n\n", { maxEventBytes: 8 }).length, 1);
});

test("a long partial line pushed in tiny chunks is scanned once (no quadratic rescan)", () => {
  const stats = { scannedChars: 0 };
  const parser = createSseParser({ stats });
  const n = 20_000;
  parser.push("data: ");
  for (let i = 0; i < n; i++) parser.push("x");
  const events = parser.push("\r");
  events.push(...parser.push("\n\n"));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.length, n);
  // A linear scan examines each character about once; a full rescan would examine n^2 / 2.
  assert.ok(stats.scannedChars <= 2 * n, `scanned ${stats.scannedChars} chars`);
});

test("a CR at a chunk end still pairs with the next LF after the scan offset moved", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push("data: a\r"), []);
  assert.deepEqual(parser.push("\n"), []);
  assert.deepEqual(parser.push("\r"), []);
  assert.deepEqual(parser.push("\n"), [{ event: undefined, data: "a", id: undefined }]);
});

test("writers refuse undefined data and event names with line breaks", () => {
  assert.throws(() => sseData(undefined), { name: "TypeError" });
  assert.throws(() => sseEvent("x", undefined), { name: "TypeError" });
  assert.throws(() => sseEvent("a\nb", {}), { message: "sseEventNameInvalid" });
  assert.throws(() => sseEvent("a\rb", {}), { message: "sseEventNameInvalid" });
  assert.throws(() => sseEvent("", {}), { message: "sseEventNameInvalid" });
  assert.equal(sseData(null), "data: null\n\n");
});
