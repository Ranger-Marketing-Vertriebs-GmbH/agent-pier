import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadFixture } from "../helpers/protocol-adapter.js";
import {
  assertResponsesStream,
  parseSseText,
} from "../helpers/protocol-adapter-shapes.js";
import {
  MODEL,
  SECRET,
  clientBody,
  translator,
  REQ,
} from "../helpers/protocol-adapter-directions.js";

const PROMPT_TOO_LONG = (prompt, max) =>
  `prompt is too long: ${prompt} tokens > ${max} maximum`;

// Claude Code compacts on these exact wordings (facts §1.9).
const MESSAGES_WORDING = {
  // 32768 - 30000 - 1000 < 3000: shrinking max_tokens cannot help, so compact.
  "upstreams/chat/context-vllm.json": PROMPT_TOO_LONG(34096, 32768),
  "upstreams/chat/context-litellm.json": PROMPT_TOO_LONG(34096, 32768),
  "upstreams/chat/context-llamacpp.json": PROMPT_TOO_LONG(40000, 32768),
  "upstreams/chat/context-lmstudio-unverified.json": PROMPT_TOO_LONG(40000, 32768),
  "upstreams/chat/context-openai-unverified.json": PROMPT_TOO_LONG(130000, 128000),
  "upstreams/chat/context-azure-unverified.json": PROMPT_TOO_LONG(130000, 128000),
};
const RESPONSES_CONTEXT = [
  ["chat", "upstreams/chat/context-vllm.json"],
  ["chat", "upstreams/chat/context-litellm.json"],
  ["chat", "upstreams/chat/context-llamacpp.json"],
  ["chat", "upstreams/chat/context-lmstudio-unverified.json"],
  ["chat", "upstreams/chat/context-openai-unverified.json"],
  ["chat", "upstreams/chat/context-azure-unverified.json"],
  ["messages", "upstreams/messages/prompt-too-long.json"],
];

/** A translator with one built request, so errors echo the request's ids and model. */
function prepared(client, upstream, overrides) {
  const instance = translator(client, upstream, overrides);
  const body = clientBody(
    client === "messages" ? "clients/claude-code/text.json" : "clients/codex/text.json",
  );
  const built = instance.buildUpstream(body, {}, { requestId: "req_fixed", now: 0 });
  assert.equal(built.ok, true);
  return { instance, built, exchange: built.exchange };
}

describe("context overflow per client", () => {
  for (const [path, wording] of Object.entries(MESSAGES_WORDING)) {
    test(`Claude Code ← chat ${path}: exact compaction wording`, () => {
      const { exchange } = prepared("messages", "chat");
      const rendered = exchange.translateError(loadFixture(path), { streaming: true });
      assert.equal(rendered.status, 400);
      assert.deepEqual(rendered.body, {
        type: "error",
        error: { type: "invalid_request_error", message: wording },
      });
    });
  }

  for (const [upstream, path] of RESPONSES_CONTEXT) {
    test(`Codex ← ${upstream} ${path}: context_length_exceeded`, () => {
      const { exchange } = prepared("responses", upstream);
      const streamed = exchange.translateError(loadFixture(path), { streaming: true });
      assert.equal(streamed.status, 200);
      assert.equal(streamed.headers["content-type"], "text/event-stream");
      const { response, events } = assertResponsesStream(streamed.body);
      assert.deepEqual(
        events.map((event) => event.type),
        ["response.created", "response.failed"],
      );
      assert.equal(response.id, "req_fixed");
      assert.equal(response.model, "qwen3-coder:30b");
      assert.equal(response.error.code, "context_length_exceeded");
      const plain = exchange.translateError(loadFixture(path), { streaming: false });
      assert.equal(plain.status, 400);
      assert.equal(plain.body.error.code, "context_length_exceeded");
    });
  }
});

describe("rate limits and overload", () => {
  const chat429 = {
    status: 429,
    headers: { "retry-after": "12", "x-request-id": "upstream-req" },
    body: { error: { message: "Too many requests", type: "rate_limit_exceeded" } },
  };

  test("Claude Code ← chat 429 keeps retry-after and nothing else", () => {
    const { exchange } = prepared("messages", "chat");
    const rendered = exchange.translateError(chat429, { streaming: true });
    assert.equal(rendered.status, 429);
    assert.equal(rendered.body.error.type, "rate_limit_error");
    assert.deepEqual(rendered.headers, {
      "content-type": "application/json",
      "retry-after": "12",
    });
  });

  test("Codex ← messages 429: in-stream rate_limit_exceeded, HTTP 429 without stream", () => {
    const { exchange } = prepared("responses", "messages");
    const fixture = loadFixture("upstreams/messages/rate-limit.json");
    const streamed = exchange.translateError(fixture, { streaming: true });
    const { response } = assertResponsesStream(streamed.body);
    assert.deepEqual(response.error, {
      code: "rate_limit_exceeded",
      message: "Rate limit reached. Please try again in 30s.",
    });
    const plain = exchange.translateError(fixture, { streaming: false });
    assert.equal(plain.status, 429);
    assert.equal(plain.headers["retry-after"], "30");
  });

  test("Codex ← messages 529 overloaded: retryable server_error", () => {
    const { exchange } = prepared("responses", "messages");
    const streamed = exchange.translateError(
      loadFixture("upstreams/messages/overloaded.json"),
      {
        streaming: true,
      },
    );
    assert.equal(
      assertResponsesStream(streamed.body).response.error.code,
      "server_error",
    );
  });

  test("Codex ← chat 401: in-stream invalid_prompt (ruling), HTTP 401 without stream", () => {
    const { exchange } = prepared("responses", "chat");
    const auth = { status: 401, body: { error: { message: "bad key" } } };
    const streamed = exchange.translateError(auth, { streaming: true });
    assert.equal(streamed.status, 200);
    assert.equal(
      assertResponsesStream(streamed.body).response.error.code,
      "invalid_prompt",
    );
    assert.equal(exchange.translateError(auth, { streaming: false }).status, 401);
  });

  test("a started Claude Code stream gets an in-stream error frame", () => {
    const { exchange } = prepared("messages", "responses");
    const frame = exchange.translateError(chat429, { streaming: true, started: true });
    assert.equal(typeof frame, "string");
    const [event] = parseSseText(frame);
    assert.equal(event.event, "error");
    assert.equal(event.data.error.type, "rate_limit_error");
  });

  test("secrets never reach the client", () => {
    const { exchange } = prepared("messages", "chat");
    const leaky = {
      status: 500,
      body: { error: { message: `upstream key ${SECRET} failed` } },
    };
    const rendered = exchange.translateError(leaky, { streaming: true });
    assert.ok(!JSON.stringify(rendered).includes(SECRET));
    assert.match(rendered.body.error.message, /\[redacted\]/);
  });
});

describe("request rejections", () => {
  test("Codex previous_response_id is rejected in the client's error format", () => {
    const instance = translator("responses", "chat");
    const body = {
      ...clientBody("clients/codex/text.json"),
      previous_response_id: "resp_1",
    };
    const streamed = instance.buildUpstream(body, {}, REQ);
    assert.equal(streamed.ok, false);
    assert.equal(streamed.error.status, 200);
    const { response } = assertResponsesStream(streamed.error.body);
    assert.equal(response.error.code, "invalid_prompt");
    const plain = instance.buildUpstream({ ...body, stream: false }, {}, REQ);
    assert.equal(plain.error.status, 400);
    assert.equal(plain.error.body.error.type, "invalid_request_error");
  });

  test("malformed Claude Code body → 400 invalid_request_error", () => {
    const instance = translator("messages", "chat");
    const built = instance.buildUpstream(
      { model: "m", messages: "nope", stream: true },
      {},
      REQ,
    );
    assert.equal(built.ok, false);
    assert.equal(built.error.status, 400);
    assert.equal(built.error.body.error.type, "invalid_request_error");
    assert.equal(instance.diagnostics().errors["request.invalid"], 1);
  });

  test("empty conversation toward Messages → invalidRequest, not a throw", () => {
    const instance = translator("responses", "messages");
    const built = instance.buildUpstream(
      { model: "m", input: [], stream: false },
      {},
      REQ,
    );
    assert.equal(built.ok, false);
    assert.equal(built.error.status, 400);
    assert.match(built.error.body.error.message, /no message is left/);
  });

  test("image input to a model without images is rejected", () => {
    const instance = translator("messages", "chat", {
      model: { ...MODEL, images: false },
    });
    const body = clientBody("clients/claude-code/image.json");
    const built = instance.buildUpstream({ ...body, stream: false }, {}, REQ);
    assert.equal(built.ok, false);
    assert.equal(built.error.status, 400);
    assert.match(built.error.body.error.message, /image/);
    const codex = translator("responses", "messages", {
      model: { ...MODEL, images: false },
    });
    assert.equal(
      codex.buildUpstream(clientBody("clients/codex/image.json"), {}, REQ).ok,
      false,
    );
  });
});

describe("keepalive, ids and diagnostics", () => {
  test("keepalive matches the client protocol", () => {
    const messages = prepared("messages", "chat").exchange;
    assert.equal(messages.keepalive(), 'event: ping\ndata: {"type":"ping"}\n\n');
    const responses = prepared("responses", "chat").exchange;
    const [frame] = parseSseText(responses.keepalive());
    assert.equal(frame.event, "response.in_progress");
    assert.equal(frame.data.response.id, "req_fixed");
  });

  test("requestId is required and echoed as the client id", () => {
    const instance = translator("responses", "chat");
    const body = clientBody("clients/codex/text.json");
    for (const options of [undefined, {}, { requestId: "" }]) {
      assert.throws(() => instance.buildUpstream(body, {}, options), TypeError);
    }
    const built = instance.buildUpstream(body, {}, { requestId: "resp_random_1" });
    const [frame] = parseSseText(built.exchange.keepalive());
    assert.equal(frame.data.response.id, "resp_random_1");
  });

  test("the translator exposes no request-scoped methods", () => {
    const instance = translator("messages", "chat");
    assert.deepEqual(Object.keys(instance).sort(), [
      "buildUpstream",
      "diagnostics",
      "setCapability",
    ]);
  });

  test("diagnostics count dropped hints, adjustments and per request", () => {
    const instance = translator("responses", "messages");
    const body = clientBody("clients/codex/text.json");
    instance.buildUpstream(body, {}, REQ);
    instance.buildUpstream(body, {}, REQ);
    const { dropped, adjustments, estimatedUsage } = instance.diagnostics();
    assert.equal(dropped["hints.clientMetadata"], 2);
    assert.equal(dropped["tools.web_search"], 2);
    assert.equal(adjustments["cache.autoBreakpoints"], 2);
    assert.equal(estimatedUsage, 0);
  });

  test("consumed hints are not dropped; errors and adjustments have their own counters", () => {
    for (const upstream of ["messages", "chat"]) {
      const instance = translator("responses", upstream);
      const body = {
        ...clientBody("clients/codex/text.json"),
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      const built = instance.buildUpstream(body, {}, REQ);
      assert.ok(!built.dropped.includes("hints.store"), upstream);
      assert.ok(!built.dropped.includes("hints.include"), upstream);
      instance.buildUpstream({ ...body, previous_response_id: "resp_1" }, {}, REQ);
      instance.buildUpstream({ model: "m", input: 7 }, {}, REQ);
      const { dropped, errors } = instance.diagnostics();
      assert.equal(dropped["hints.store"], undefined);
      assert.equal(dropped["request.rejected"], undefined);
      assert.equal(errors["request.rejected"], 1);
      assert.equal(errors["request.invalid"], 1);
    }
    const claude = translator("responses", "messages");
    const body = clientBody("clients/codex/text.json");
    claude.buildUpstream(
      { ...body, reasoning: { effort: "minimal" }, temperature: 0.5 },
      {},
      REQ,
    );
    const { dropped, adjustments } = claude.diagnostics();
    assert.equal(adjustments.effortMinimalToLow, 1);
    assert.equal(dropped.effortMinimalToLow, undefined);
    assert.equal(dropped.temperatureDropped, 1, "sampling drops stay feature drops");
  });

  test("secrets: null is treated as no secrets", () => {
    const instance = translator("messages", "chat", { secrets: null });
    const built = instance.buildUpstream(
      clientBody("clients/claude-code/text.json"),
      {},
      REQ,
    );
    assert.equal(built.ok, true);
    const rendered = built.exchange.translateError({ status: 500, body: "boom" });
    assert.equal(rendered.body.error.message, "boom");
  });
});
