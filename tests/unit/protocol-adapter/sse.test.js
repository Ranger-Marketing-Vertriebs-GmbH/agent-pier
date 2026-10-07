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

test("an event without data is still reported", () => {
  assert.deepEqual(parseAll("event: ping\n\n"), [
    { event: "ping", data: "", id: undefined },
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
