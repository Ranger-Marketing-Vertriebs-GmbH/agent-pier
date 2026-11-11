import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { BLOCK_LIMIT } from "../../server/features/mcp-servers/sse-endpoint-rewriter.js";
import { cut, rewritten } from "../helpers/sse-rewriter.js";

// What an event stream is made of, with every line end and with characters of two,
// three and four bytes; `endpoint` appears only as text inside a line.
const plain = fc.oneof(
  fc.constantFrom(
    "\n",
    "\r\n",
    "\r",
    "event: message",
    "event:",
    "data: ",
    "id: 1",
    ": comment",
    '{"jsonrpc":"2.0"}',
    " event: endpoint",
    "ü",
    "€",
    "😀",
    " ",
  ),
  fc.uint8Array({ maxLength: 4 }).filter((bytes) => !bytes.includes(0x65)),
);
const stream = (parts) =>
  fc
    .array(parts, { maxLength: 60 })
    .map((list) => Buffer.concat(list.map((part) => Buffer.from(part))));
const sizes = fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 80 });

test("a stream without an endpoint event passes byte for byte under any chunking", async () => {
  await check(
    fc.asyncProperty(stream(plain), sizes, async (bytes, cuts) => {
      const result = await rewritten(cut(bytes, cuts));
      assert.equal(result.error, null);
      assert.ok(result.bytes.equals(bytes));
    }),
    { numRuns: 500 },
  );
});

test("a block beyond the limit passes byte for byte under any chunking", async () => {
  const large = fc
    .tuple(stream(plain), fc.integer({ min: 1, max: 3 * BLOCK_LIMIT }), stream(plain))
    .map(([head, size, tail]) =>
      Buffer.concat([head, Buffer.from("data: "), Buffer.alloc(size, "€"), tail]),
    );
  const cuts = fc.array(fc.integer({ min: 1, max: BLOCK_LIMIT }), { maxLength: 40 });
  await check(
    fc.asyncProperty(large, cuts, async (bytes, at) => {
      const result = await rewritten(cut(bytes, at));
      assert.equal(result.error, null);
      assert.ok(result.bytes.equals(bytes));
    }),
    { numRuns: 60 },
  );
});

test("how a stream with endpoint events is cut does not change the result", async () => {
  const any = fc.oneof(
    { weight: 4, arbitrary: plain },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "event: endpoint",
        "event:endpoint ",
        "data: /messages?sessionId=1",
        "data: https://other.example/post",
        "data: http://[",
        "data:https://mcp.example/ü",
      ),
    },
  );
  await check(
    fc.asyncProperty(stream(any), sizes, async (bytes, cuts) => {
      const whole = await rewritten([bytes]);
      const parts = await rewritten(cut(bytes, cuts));
      assert.equal(whole.error, null);
      assert.equal(parts.error, null);
      assert.ok(parts.bytes.equals(whole.bytes));
    }),
    { numRuns: 500 },
  );
});
