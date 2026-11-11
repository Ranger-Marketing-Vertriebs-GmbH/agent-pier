import test from "node:test";
import assert from "node:assert/strict";
import { BLOCK_LIMIT } from "../../server/features/mcp-servers/sse-endpoint-rewriter.js";
import { cut, rewritten, routed } from "../helpers/sse-rewriter.js";

const text = async (chunks) => {
  const { bytes, error } = await rewritten(chunks);
  assert.equal(error, null);
  return bytes.toString("utf8");
};
const message = "event: message\ndata: after\n\n";

test("the endpoint event names the proxy's message route, relative or absolute", async () => {
  assert.equal(
    await text(["event: endpoint\ndata: /messages?sessionId=a1\n\n", message]),
    `event: endpoint\ndata: ${routed("/messages?sessionId=a1")}\n\n${message}`,
  );
  assert.equal(
    await text(["event: endpoint\ndata: https://mcp.example/post?s=ü\n\n"]),
    `event: endpoint\ndata: ${routed("/post?s=%C3%BC")}\n\n`,
  );
  assert.equal(
    await text(["event: endpoint\ndata: messages\n\n"]),
    `event: endpoint\ndata: ${routed("/base/messages")}\n\n`,
  );
});

test("an endpoint off the server's origin, or one that is no URL, becomes about:blank", async () => {
  for (const value of [
    "https://other.example/messages",
    "http://mcp.example/messages",
    "//other.example/messages",
    "http://[",
    "https://mcp.example:99999/",
    "http://%zz/",
  ])
    assert.equal(
      await text([`event: endpoint\ndata: ${value}\n\n`, message]),
      `event: endpoint\ndata: about:blank\n\n${message}`,
      value,
    );
});

test("an endpoint event the stream ends in is rewritten without its blank line", async () => {
  assert.equal(
    await text(["event: endpoint\ndata: http://["]),
    "event: endpoint\ndata: about:blank",
  );
  assert.equal(
    await text(["event: endpoint\ndata: /post\n"]),
    `event: endpoint\ndata: ${routed("/post")}\n`,
  );
});

test("the endpoint event is found with every line end and at every chunk boundary", async () => {
  const expected = (end) =>
    `id: 1\nevent: endpoint\ndata: ${routed("/post")}${end}${end}${message}`;
  for (const end of ["\n", "\r\n", "\r"]) {
    const bytes = Buffer.from(
      `id: 1${end}event: endpoint${end}data: /post${end}${end}${message}`,
    );
    for (let at = 1; at < bytes.length; at++)
      assert.equal(
        await text([bytes.subarray(0, at), bytes.subarray(at)]),
        expected(end),
        `${JSON.stringify(end)} cut at ${at}`,
      );
    assert.equal(await text(cut(bytes, Array(bytes.length).fill(1))), expected(end));
  }
});

test("a block that never ends is not held beyond the limit, and all of it arrives", async () => {
  const piece = Buffer.alloc(16 * 1024, "x");
  const chunks = ["event: message\ndata: ", ...Array(256).fill(piece)];
  const { bytes, error, most } = await rewritten(chunks);
  assert.equal(error, null);
  assert.ok(most <= BLOCK_LIMIT + piece.length, `held ${most} bytes`);
  assert.equal(bytes.length, 21 + 256 * piece.length);
  assert.equal(bytes.subarray(0, 21).toString(), "event: message\ndata: ");
  assert.ok(bytes.subarray(21).every((byte) => byte === 120));
});

test("a large message passes intact however it is cut, and the next event is still read", async () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: { text: "Grüße, 100 €, 😀 event: endpoint ".repeat(30_000) },
  });
  const large = `id: 9\r\nevent: message\r\ndata: ${body}\r\n\r\n`;
  assert.ok(Buffer.byteLength(large) > 16 * BLOCK_LIMIT);
  const input = Buffer.from(`${large}event: endpoint\r\ndata: /post\r\n\r\n${message}`);
  const expected = `${large}event: endpoint\ndata: ${routed("/post")}\r\n\r\n${message}`;
  // 1021 and 4093 cut the multi-byte characters and the CRLFs at changing offsets.
  for (const size of [1021, 4093, 65_536, input.length]) {
    const sizes = Array(Math.ceil(input.length / size)).fill(size);
    const { bytes, error, most } = await rewritten(cut(input, sizes));
    assert.equal(error, null);
    assert.ok(bytes.equals(Buffer.from(expected)), `chunks of ${size} bytes`);
    if (size < input.length) assert.ok(most <= BLOCK_LIMIT + size, `held ${most}`);
  }
  // The blank line that ends the large block, split at each of its bytes.
  const end = Buffer.byteLength(large);
  for (const at of [end - 3, end - 2, end - 1]) {
    const { bytes } = await rewritten([input.subarray(0, at), input.subarray(at)]);
    assert.ok(bytes.equals(Buffer.from(expected)), `cut at the block end - ${end - at}`);
  }
});

test("an endpoint event beyond the limit ends the stream instead of passing as it is", async () => {
  const filler = "x".repeat(2 * BLOCK_LIMIT);
  const piece = (value) => cut(Buffer.from(value), Array(64).fill(4096));
  for (const [name, block] of [
    ["event line first", `event: endpoint\ndata: https://other.example/${filler}\n\n`],
    ["event line last", `data: https://other.example/${filler}\nevent: endpoint\n\n`],
    ["CR line ends", `data: https://other.example/${filler}\revent:endpoint\r\r`],
  ]) {
    const { bytes, error } = await rewritten(piece(block));
    assert.match(String(error?.message), /endpoint event that is too large/, name);
    assert.doesNotMatch(bytes.toString("latin1"), /event:\s*endpoint/, name);
  }
  // Split inside the event line, after the block already passes through.
  const { error } = await rewritten([`data: ${filler}`, "x\nevent: endp", "oint\n\n"]);
  assert.match(String(error?.message), /too large/);
});
