import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTransportError,
  classifyUpstreamError,
  messagesErrorBody,
  messagesErrorEvent,
  parseRetryAfter,
  responsesErrorBody,
  responsesErrorStream,
  responsesFailedEvent,
  sanitizeMessage,
} from "../../../server/features/protocol-adapter/errors.js";
import { createSseParser } from "../../../server/features/protocol-adapter/sse.js";
import { assertIrEvent } from "../../../server/features/protocol-adapter/ir.js";
import { loadFixture } from "../../helpers/protocol-adapter.js";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const sseEvents = (text) => {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.end()].map((event) => ({
    event: event.event,
    data: JSON.parse(event.data),
  }));
};

const fromFixture = (protocol, file) => {
  const fixture = loadFixture(file);
  return classifyUpstreamError({ protocol, ...fixture, now: NOW });
};

const assertValid = (error) =>
  assert.doesNotThrow(() => assertIrEvent({ type: "error", error }));

const CONTEXT_FIXTURES = [
  ["messages", "upstreams/messages/prompt-too-long.json", 215000, 200000],
  ["chat", "upstreams/chat/context-vllm.json", 30000, 32768, 4096],
  ["chat", "upstreams/chat/context-litellm.json", 30000, 32768, 4096],
  ["chat", "upstreams/chat/context-llamacpp.json", 40000, 32768],
  ["chat", "upstreams/chat/context-lmstudio-unverified.json", 40000, 32768],
  ["chat", "upstreams/chat/context-openai-unverified.json", 130000, 128000],
  ["chat", "upstreams/chat/context-azure-unverified.json", 130000, 128000, 2000],
];

for (const [protocol, file, prompt, max, output] of CONTEXT_FIXTURES) {
  test(`classifies ${file} as contextLength with token numbers`, () => {
    const error = fromFixture(protocol, file);
    assertValid(error);
    assert.equal(error.kind, "contextLength");
    assert.equal(error.status, 400);
    assert.equal(error.promptTokens, prompt);
    assert.equal(error.contextWindow, max);
    assert.equal(error.outputTokens, output);
  });

  test(`renders ${file} for the Messages client in Claude Code's wording`, () => {
    const { status, body } = messagesErrorBody(fromFixture(protocol, file));
    assert.equal(status, 400);
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
    const ccRegex = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i;
    const shrink =
      /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/;
    // Claude Code can only shrink max_tokens when ≥ 3000 tokens stay after its margin.
    const shrinkable =
      output !== undefined && prompt <= max && max - prompt - 1000 >= 3000;
    if (!shrinkable) {
      const total = prompt > max || output === undefined ? prompt : prompt + output;
      assert.equal(
        body.error.message,
        `prompt is too long: ${total} tokens > ${max} maximum`,
      );
      assert.deepEqual(ccRegex.exec(body.error.message).slice(1), [`${total}`, `${max}`]);
    } else {
      assert.deepEqual(shrink.exec(body.error.message).slice(1), [
        `${prompt}`,
        `${output}`,
        `${max}`,
      ]);
    }
  });

  test(`renders ${file} for the Responses client as context_length_exceeded`, () => {
    const error = fromFixture(protocol, file);
    const events = sseEvents(
      responsesErrorStream(error, { responseId: "resp_1", model: "m" }),
    );
    assert.deepEqual(
      events.map((event) => event.event),
      ["response.created", "response.failed"],
    );
    assert.equal(events[1].data.response.error.code, "context_length_exceeded");
    assert.equal(responsesErrorBody(error).body.error.code, "context_length_exceeded");
    assert.equal(responsesErrorBody(error).status, 400);
  });
}

test("Responses upstream context overflow in response.failed is classified", () => {
  const events = sseEvents(loadFixture("upstreams/responses/failed-context-length.sse"));
  const failed = events.find((event) => event.event === "response.failed");
  const error = classifyUpstreamError({ protocol: "responses", body: failed.data });
  assertValid(error);
  assert.equal(error.kind, "contextLength");
  assert.equal(error.status, null);
  assert.equal(messagesErrorBody(error).body.error.message, "prompt is too long");
});

test("Messages in-stream overloaded error event is classified without a status", () => {
  const events = sseEvents(loadFixture("upstreams/messages/error-overloaded.sse"));
  const error = classifyUpstreamError({
    protocol: "messages",
    body: events.at(-1).data,
  });
  assert.equal(error.kind, "overloaded");
  assert.equal(error.message, "Overloaded");
});

test("Chat error chunks and raw text bodies are classified", () => {
  const chunk = classifyUpstreamError({
    protocol: "chat",
    body: { error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" } },
  });
  assert.equal(chunk.kind, "rateLimit");
  const text = classifyUpstreamError({
    protocol: "chat",
    status: 400,
    body: JSON.stringify({ error: "exceeds the available context size (9 tokens)" }),
  });
  assert.equal(text.kind, "contextLength");
  const plain = classifyUpstreamError({
    protocol: "chat",
    status: 502,
    body: "Bad Gateway",
  });
  assert.deepEqual(plain, { kind: "server", status: 502, message: "Bad Gateway" });
  const empty = classifyUpstreamError({ protocol: "chat", status: 500 });
  assert.equal(empty.message, "Upstream returned HTTP 500");
  const unknown = classifyUpstreamError({ protocol: "responses", body: {} });
  assert.equal(unknown.kind, "server");
});

test("status maps to the error kind first", () => {
  const cases = [
    [400, "invalidRequest"],
    [401, "auth"],
    [403, "permission"],
    [404, "notFound"],
    [408, "timeout"],
    [413, "invalidRequest"],
    [422, "invalidRequest"],
    [429, "rateLimit"],
    [500, "server"],
    [502, "server"],
    [503, "overloaded"],
    [504, "timeout"],
    [529, "overloaded"],
  ];
  for (const [status, kind] of cases) {
    const body = { error: { type: "overloaded_error", message: "x" } };
    assert.equal(classifyUpstreamError({ protocol: "chat", status, body }).kind, kind);
  }
});

test("type and code recognizers apply to status-less errors", () => {
  const cases = [
    [{ type: "error", error: { type: "authentication_error", message: "" } }, "auth"],
    [{ type: "error", error: { type: "permission_error", message: "" } }, "permission"],
    [{ type: "error", error: { type: "billing_error", message: "" } }, "permission"],
    [{ type: "error", error: { type: "not_found_error", message: "" } }, "notFound"],
    [{ type: "error", error: { type: "rate_limit_error", message: "" } }, "rateLimit"],
    [{ type: "error", error: { type: "api_error", message: "" } }, "server"],
    [{ type: "error", error: { type: "timeout_error", message: "" } }, "timeout"],
    [
      { type: "error", error: { type: "invalid_request_error", message: "" } },
      "invalidRequest",
    ],
    [{ type: "error", code: "server_is_overloaded", message: "busy" }, "overloaded"],
    [{ response: { error: { code: "slow_down", message: "" } } }, "rateLimit"],
    [{ response: { error: { code: "invalid_prompt", message: "" } } }, "invalidRequest"],
    [{ response: { error: { code: "server_error", message: "" } } }, "server"],
  ];
  for (const [body, kind] of cases) {
    assert.equal(classifyUpstreamError({ protocol: "responses", body }).kind, kind);
  }
});

test("quota exhaustion is a permission error, not a retryable rate limit", () => {
  const error = classifyUpstreamError({
    protocol: "chat",
    status: 429,
    body: { error: { message: "You exceeded your quota", code: "insufficient_quota" } },
  });
  assert.equal(error.kind, "permission");
});

test("413 mentioning the context window counts as context overflow", () => {
  const error = classifyUpstreamError({
    protocol: "messages",
    status: 413,
    body: "request exceeds the model context window",
  });
  assert.equal(error.kind, "contextLength");
});

test("Anthropic max_tokens overflow keeps all three numbers", () => {
  const message =
    "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000, " +
    "decrease input length or `max_tokens` and try again";
  const error = classifyUpstreamError({
    protocol: "messages",
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message } },
  });
  assert.equal(error.kind, "contextLength");
  assert.match(
    messagesErrorBody(error).body.error.message,
    /^input length and `max_tokens` exceed context limit: 188059 \+ 20000 > 200000/,
  );
});

test("max_tokens wording only when Claude Code can shrink to ≥ 3000 tokens", () => {
  const render = (promptTokens, outputTokens, contextWindow) =>
    messagesErrorBody({
      kind: "contextLength",
      status: 400,
      message: "x",
      promptTokens,
      outputTokens,
      contextWindow,
    }).body.error.message;
  // 32768 - 28768 - 1000 = 3000: shrinking still leaves 3000 output tokens.
  assert.match(render(28768, 8000, 32768), /^input length and `max_tokens` exceed/);
  // 2999 left: Claude Code would give up, so it must compact instead.
  assert.equal(
    render(28769, 8000, 32768),
    "prompt is too long: 36769 tokens > 32768 maximum",
  );
  assert.equal(
    render(40000, 8000, 32768),
    "prompt is too long: 40000 tokens > 32768 maximum",
  );
});

test("retry-after is read from seconds, HTTP dates and retry-after-ms", () => {
  const fixture = fromFixture("messages", "upstreams/messages/rate-limit.json");
  assert.equal(fixture.kind, "rateLimit");
  assert.equal(fixture.retryAfter, 30);
  const date = new Date(NOW + 12_000).toUTCString();
  const classify = (headers) =>
    classifyUpstreamError({ protocol: "chat", status: 429, headers, now: NOW })
      .retryAfter;
  assert.equal(classify({ "Retry-After": date }), 12);
  assert.equal(classify({ "retry-after-ms": "1500" }), 1.5);
  assert.equal(classify(new Map([["retry-after", "7"]])), 7);
  assert.equal(classify({ "retry-after": "garbage" }), undefined);
  assert.equal(parseRetryAfter(new Date(NOW - 5000).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter(date), undefined);
});

test("retry delay falls back to the 'try again in' wording of rate limits", () => {
  const error = classifyUpstreamError({
    protocol: "responses",
    body: {
      response: {
        error: { code: "rate_limit_exceeded", message: "Please try again in 850ms." },
      },
    },
  });
  assert.equal(error.retryAfter, 0.85);
});

test("sanitizeMessage truncates, strips control characters and redacts secrets", () => {
  assert.equal(sanitizeMessage("a\u0000b\u001b[31mc\u007f\td\ne", []), "ab[31mc d e");
  assert.equal(sanitizeMessage("x".repeat(800)).length, 500);
  assert.equal(
    sanitizeMessage("bad key sk-secret-123 and sk-secret-123 again", [
      "sk-secret-123",
      "",
    ]),
    "bad key [redacted] and [redacted] again",
  );
  assert.equal(sanitizeMessage(undefined), "");
  assert.equal(
    sanitizeMessage("header Bearer abcdefgh12345 key sk-abcdefghijklmnop1234"),
    "header Bearer [redacted] key [redacted]",
  );
  const long = `${"y".repeat(495)}sk-secret-123`;
  assert.ok(!sanitizeMessage(long, ["sk-secret-123"]).includes("sk-sec"));
});

test("classifyUpstreamError redacts secrets and ignores upstream headers", () => {
  const error = classifyUpstreamError({
    protocol: "chat",
    status: 401,
    headers: { "x-request-id": "req_abc", "set-cookie": "s=1" },
    body: { error: { message: "Invalid key tok-ABC for user", code: "invalid_api_key" } },
    secrets: ["tok-ABC"],
  });
  assert.deepEqual(error, {
    kind: "auth",
    status: 401,
    message: "Invalid key [redacted] for user",
  });
  const rendered = JSON.stringify([messagesErrorBody(error), responsesErrorBody(error)]);
  assert.ok(!rendered.includes("req_abc"));
  assert.ok(!rendered.includes("s=1"));
});

const ir = (kind, extra = {}) => ({
  kind,
  status: null,
  message: `${kind} msg`,
  ...extra,
});

test("messagesErrorBody maps every kind to the Anthropic status and type", () => {
  const cases = {
    auth: [401, "authentication_error"],
    permission: [403, "permission_error"],
    notFound: [404, "not_found_error"],
    rateLimit: [429, "rate_limit_error"],
    overloaded: [529, "overloaded_error"],
    invalidRequest: [400, "invalid_request_error"],
    contextLength: [400, "invalid_request_error"],
    server: [500, "api_error"],
    timeout: [504, "timeout_error"],
    network: [502, "api_error"],
  };
  for (const [kind, [status, type]] of Object.entries(cases)) {
    const result = messagesErrorBody(ir(kind));
    assert.equal(result.status, status, kind);
    assert.equal(result.body.error.type, type, kind);
    assert.deepEqual(Object.keys(result.body).sort(), ["error", "type"], kind);
    assert.deepEqual(result.headers, {}, kind);
  }
  assert.equal(
    messagesErrorBody(ir("server", { message: "" })).body.error.message,
    "server error",
  );
});

test("Messages rate limits carry retry-after as integer seconds", () => {
  assert.deepEqual(messagesErrorBody(ir("rateLimit", { retryAfter: 2.2 })).headers, {
    "retry-after": "3",
  });
  assert.deepEqual(messagesErrorBody(ir("overloaded", { retryAfter: 0 })).headers, {
    "retry-after": "0",
  });
});

test("messagesErrorEvent renders an in-stream error event", () => {
  const [event] = sseEvents(
    messagesErrorEvent(ir("overloaded", { message: "Overloaded" })),
  );
  assert.deepEqual(event, {
    event: "error",
    data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  });
  const [context] = sseEvents(
    messagesErrorEvent(ir("contextLength", { promptTokens: 5, contextWindow: 4 })),
  );
  assert.equal(context.data.error.message, "prompt is too long: 5 tokens > 4 maximum");
});

test("responsesErrorBody maps statuses for HTTP errors", () => {
  const cases = {
    auth: [401, "invalid_api_key"],
    permission: [403, null],
    notFound: [404, null],
    rateLimit: [429, "rate_limit_exceeded"],
    overloaded: [503, "server_error"],
    invalidRequest: [400, null],
    contextLength: [400, "context_length_exceeded"],
    server: [500, "server_error"],
    timeout: [504, "server_error"],
    network: [502, "server_error"],
  };
  for (const [kind, [status, code]] of Object.entries(cases)) {
    const result = responsesErrorBody(ir(kind));
    assert.equal(result.status, status, kind);
    assert.equal(result.body.error.code, code, kind);
    assert.equal(result.body.error.message, `${kind} msg`, kind);
    assert.equal(result.body.error.param, null, kind);
  }
  assert.deepEqual(responsesErrorBody(ir("rateLimit", { retryAfter: 4 })).headers, {
    "retry-after": "4",
  });
});

test("responsesErrorStream picks codes Codex retries only when retrying helps", () => {
  const cases = {
    contextLength: "context_length_exceeded",
    rateLimit: "rate_limit_exceeded",
    overloaded: "server_error",
    server: "server_error",
    timeout: "server_error",
    network: "server_error",
    invalidRequest: "invalid_prompt",
    notFound: "invalid_prompt",
    auth: "invalid_prompt",
    permission: "invalid_prompt",
  };
  for (const [kind, code] of Object.entries(cases)) {
    const text = responsesErrorStream(ir(kind), { responseId: "resp_x", model: "gpt" });
    const [created, failed] = sseEvents(text);
    assert.equal(created.data.type, "response.created");
    assert.equal(created.data.sequence_number, 0);
    assert.deepEqual(created.data.response, {
      id: "resp_x",
      object: "response",
      model: "gpt",
      status: "in_progress",
      output: [],
    });
    assert.equal(failed.data.type, "response.failed");
    assert.equal(failed.data.sequence_number, 1);
    assert.equal(failed.data.response.id, "resp_x");
    assert.equal(failed.data.response.status, "failed");
    assert.equal(failed.data.response.error.code, code, kind);
    assert.notEqual(failed.data.response.error.code, "server_is_overloaded");
  }
});

test("Codex rate limit message carries the delay in seconds", () => {
  const message = (retryAfter) => {
    const text = responsesErrorStream(ir("rateLimit", { retryAfter }), {
      responseId: "r",
      model: "m",
    });
    return sseEvents(text)[1].data.response.error.message;
  };
  assert.equal(message(undefined), "Rate limit reached. Please try again in 1s.");
  assert.equal(message(30), "Rate limit reached. Please try again in 30s.");
  assert.equal(message(0.4), "Rate limit reached. Please try again in 1s.");
  assert.match(message(30), /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i);
});

test("responsesFailedEvent continues an already started stream", () => {
  const [event] = sseEvents(
    responsesFailedEvent(ir("server"), {
      responseId: "r",
      model: "m",
      sequenceNumber: 9,
    }),
  );
  assert.equal(event.event, "response.failed");
  assert.equal(event.data.sequence_number, 9);
  assert.equal(event.data.response.error.message, "server msg");
});

test("status-less errors with a numeric code use it as the status", () => {
  const vllm = classifyUpstreamError({
    protocol: "chat",
    body: { error: { message: "slow down", code: 429 } },
  });
  assert.equal(vllm.kind, "rateLimit");
  assert.equal(vllm.status, 429);
  const text = classifyUpstreamError({
    protocol: "chat",
    body: { error: { message: "busy", code: "503" } },
  });
  assert.equal(text.kind, "overloaded");
  assert.equal(text.status, 503);
  const http = classifyUpstreamError({
    protocol: "chat",
    status: 500,
    body: { error: { message: "x", code: 429 } },
  });
  assert.equal(http.status, 500, "the HTTP status wins");
  const odd = classifyUpstreamError({
    protocol: "chat",
    body: { error: { message: "x", code: 7 } },
  });
  assert.equal(odd.status, null, "codes outside 400–599 are not statuses");
});

test("classifyTransportError: timeouts, socket errors and classifier hints", () => {
  const abort = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  assert.deepEqual(classifyTransportError(abort), {
    kind: "timeout",
    status: null,
    message: "upstream timed out",
  });
  const undici = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
  });
  assert.equal(classifyTransportError(undici).kind, "timeout");
  const reset = Object.assign(new Error("read ECONNRESET sk-abcdefghijklmnop0123"), {
    code: "ECONNRESET",
  });
  const network = classifyTransportError(reset);
  assert.equal(network.kind, "network");
  assert.equal(network.message, "read ECONNRESET [redacted]");
  const hinted = Object.assign(new Error("idle for 240 s"), { adapterKind: "timeout" });
  assert.deepEqual(classifyTransportError(hinted), {
    kind: "timeout",
    status: null,
    message: "idle for 240 s",
  });
  const bogus = Object.assign(new Error("x"), { adapterKind: "bogus" });
  assert.equal(classifyTransportError(bogus).kind, "network");
  assert.equal(classifyTransportError(undefined).message, "upstream unreachable");
});
