import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseSseText } from "../helpers/protocol-adapter-shapes.js";
import {
  SECRET,
  clientBody,
  translator,
} from "../helpers/protocol-adapter-directions.js";

const chatChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-up",
    model: "chat-up",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const abortError = () =>
  Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
const socketError = () =>
  Object.assign(new Error(`read ECONNRESET ${SECRET}`), { code: "ECONNRESET" });

/** Upstream chunks: a text delta, then the iterator throws `error`. */
async function* failingAfterText(error) {
  yield chatChunk({ role: "assistant", content: "hel" });
  yield chatChunk({ content: "lo" });
  throw error;
}

async function* failingImmediately(error) {
  yield* [];
  throw error;
}

function exchangeFor(client, { stream = true } = {}) {
  const instance = translator(client, "chat");
  const path =
    client === "messages" ? "clients/claude-code/text.json" : "clients/codex/text.json";
  const built = instance.buildUpstream(
    { ...clientBody(path), stream },
    {},
    { requestId: "req_fail", now: 0 },
  );
  assert.equal(built.ok, true);
  return { instance, exchange: built.exchange };
}

async function frames(iterable) {
  const result = [];
  for await (const frame of iterable) result.push(frame);
  return result;
}

const sequenceNumbers = (text) =>
  parseSseText(text).map((frame) => frame.data.sequence_number);

describe("upstream iterator failures inside translateStream", () => {
  test("Claude Code: AbortError mid-stream ends in a timeout event: error", async () => {
    const { exchange, instance } = exchangeFor("messages");
    const output = await frames(exchange.translateStream(failingAfterText(abortError())));
    const last = parseSseText(output.at(-1)).at(-1);
    assert.equal(last.event, "error");
    assert.equal(last.data.error.type, "timeout_error");
    assert.ok(parseSseText(output.join("")).some((f) => f.event === "message_start"));
    assert.equal(instance.diagnostics().errors["stream.timeout"], 1);
  });

  test("Claude Code: socket reset ends in a network error without secrets", async () => {
    const { exchange } = exchangeFor("messages");
    const text = (await frames(exchange.translateStream(failingAfterText(socketError()))))
      .join("")
      .toString();
    const last = parseSseText(text).at(-1);
    assert.equal(last.event, "error");
    assert.equal(last.data.error.type, "api_error");
    assert.ok(!text.includes(SECRET));
  });

  test("Codex: mid-stream failure is response.failed with the next sequence number", async () => {
    const { exchange } = exchangeFor("responses");
    const text = (
      await frames(exchange.translateStream(failingAfterText(abortError())))
    ).join("");
    const parsed = parseSseText(text);
    const numbers = sequenceNumbers(text);
    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index),
    );
    assert.equal(parsed.at(-1).event, "response.failed");
    assert.equal(parsed.at(-1).data.response.error.code, "server_error");
    assert.equal(parsed.at(-1).data.response.id, "req_fail");
  });

  test("Codex: a classifier hint on the error wins", async () => {
    const { exchange } = exchangeFor("responses");
    const hinted = Object.assign(new Error("slow down"), { adapterKind: "rateLimit" });
    const text = (await frames(exchange.translateStream(failingAfterText(hinted)))).join(
      "",
    );
    assert.equal(
      parseSseText(text).at(-1).data.response.error.code,
      "rate_limit_exceeded",
    );
  });

  test("failure before the first chunk: complete client error streams", async () => {
    const codex = exchangeFor("responses").exchange;
    const text = (
      await frames(codex.translateStream(failingImmediately(socketError())))
    ).join("");
    const parsed = parseSseText(text);
    assert.deepEqual(
      parsed.map((frame) => frame.event),
      ["response.created", "response.failed"],
    );
    assert.deepEqual(sequenceNumbers(text), [0, 1]);
    const claude = exchangeFor("messages").exchange;
    const [only] = await frames(claude.translateStream(failingImmediately(abortError())));
    assert.equal(parseSseText(only)[0].event, "error");
  });
});

describe("exchange.fail and translateError numbering", () => {
  const timeout = { kind: "timeout", status: null, message: `idle ${SECRET}` };

  test("fail before start renders the full client error", () => {
    const messages = exchangeFor("messages").exchange.fail(timeout);
    assert.equal(messages.status, 504);
    assert.equal(messages.body.error.type, "timeout_error");
    assert.ok(!JSON.stringify(messages).includes(SECRET));

    const streaming = exchangeFor("responses").exchange.fail(timeout);
    assert.equal(streaming.status, 200);
    assert.equal(streaming.headers["content-type"], "text/event-stream");
    assert.deepEqual(sequenceNumbers(streaming.body), [0, 1]);

    const plain = exchangeFor("responses", { stream: false }).exchange.fail(timeout);
    assert.equal(plain.status, 504);
    assert.equal(plain.body.error.type, "server_error");
  });

  test("fail with started: true before any frame writes a complete error stream", () => {
    const text = exchangeFor("responses").exchange.fail(timeout, { started: true });
    assert.equal(typeof text, "string");
    assert.deepEqual(sequenceNumbers(text), [0, 1]);
    const claude = exchangeFor("messages").exchange.fail(timeout, { started: true });
    assert.equal(parseSseText(claude)[0].event, "error");
  });

  test("fail after frames continues the client's numbering", async () => {
    const { exchange } = exchangeFor("responses");
    const written = [];
    for await (const frame of exchange.translateStream(failingAfterText(abortError()))) {
      written.push(frame);
      if (written.length === 3) break; // the caller gives up (e.g. its idle timer fired)
    }
    const text = exchange.fail(timeout);
    assert.equal(typeof text, "string");
    const [failed] = parseSseText(text);
    assert.equal(failed.event, "response.failed");
    assert.equal(failed.data.sequence_number, 3);

    const claude = exchangeFor("messages").exchange;
    for await (const frame of claude.translateStream(failingAfterText(abortError()))) {
      assert.ok(frame);
      break;
    }
    assert.equal(parseSseText(claude.fail(timeout))[0].event, "error");
  });

  test("translateError with started: true is numbered from the exchange", async () => {
    const { exchange } = exchangeFor("responses");
    const written = [];
    for await (const frame of exchange.translateStream(failingAfterText(abortError()))) {
      written.push(frame);
      if (written.length === 2) break;
    }
    const rendered = exchange.translateError(
      { status: 503, body: { error: { message: "busy" } } },
      { started: true },
    );
    assert.equal(parseSseText(rendered)[0].data.sequence_number, 2);

    const fresh = exchangeFor("responses").exchange;
    const before = fresh.translateError({ status: 503, body: "busy" }, { started: true });
    assert.deepEqual(sequenceNumbers(before), [0, 1]);
  });
});
