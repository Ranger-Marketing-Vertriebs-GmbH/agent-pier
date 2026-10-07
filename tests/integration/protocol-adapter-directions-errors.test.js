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
} from "../helpers/protocol-adapter-directions.js";

const PROMPT_TOO_LONG = (prompt, max) =>
  `prompt is too long: ${prompt} tokens > ${max} maximum`;
const EXCEEDS = (prompt, output, max) =>
  `input length and \`max_tokens\` exceed context limit: ${prompt} + ${output} > ${max}, ` +
  "decrease input length or `max_tokens` and try again";

// Claude Code compacts on these exact wordings (facts §1.9).
const MESSAGES_WORDING = {
  "upstreams/chat/context-vllm.json": EXCEEDS(30000, 4096, 32768),
  "upstreams/chat/context-litellm.json": EXCEEDS(30000, 4096, 32768),
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
  return { instance, built };
}

describe("context overflow per client", () => {
  for (const [path, wording] of Object.entries(MESSAGES_WORDING)) {
    test(`Claude Code ← chat ${path}: exact compaction wording`, () => {
      const { instance } = prepared("messages", "chat");
      const rendered = instance.translateError(loadFixture(path), { streaming: true });
      assert.equal(rendered.status, 400);
      assert.deepEqual(rendered.body, {
        type: "error",
        error: { type: "invalid_request_error", message: wording },
      });
    });
  }

  for (const [upstream, path] of RESPONSES_CONTEXT) {
    test(`Codex ← ${upstream} ${path}: context_length_exceeded`, () => {
      const { instance } = prepared("responses", upstream);
      const streamed = instance.translateError(loadFixture(path), { streaming: true });
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
      const plain = instance.translateError(loadFixture(path), { streaming: false });
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
    const { instance } = prepared("messages", "chat");
    const rendered = instance.translateError(chat429, { streaming: true });
    assert.equal(rendered.status, 429);
    assert.equal(rendered.body.error.type, "rate_limit_error");
    assert.deepEqual(rendered.headers, {
      "content-type": "application/json",
      "retry-after": "12",
    });
  });

  test("Codex ← messages 429: in-stream rate_limit_exceeded, HTTP 429 without stream", () => {
    const { instance } = prepared("responses", "messages");
    const fixture = loadFixture("upstreams/messages/rate-limit.json");
    const streamed = instance.translateError(fixture, { streaming: true });
    const { response } = assertResponsesStream(streamed.body);
    assert.deepEqual(response.error, {
      code: "rate_limit_exceeded",
      message: "Rate limit reached. Please try again in 30s.",
    });
    const plain = instance.translateError(fixture, { streaming: false });
    assert.equal(plain.status, 429);
    assert.equal(plain.headers["retry-after"], "30");
  });

  test("Codex ← messages 529 overloaded: retryable server_error", () => {
    const { instance } = prepared("responses", "messages");
    const streamed = instance.translateError(
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
    const { instance } = prepared("responses", "chat");
    const auth = { status: 401, body: { error: { message: "bad key" } } };
    const streamed = instance.translateError(auth, { streaming: true });
    assert.equal(streamed.status, 200);
    assert.equal(
      assertResponsesStream(streamed.body).response.error.code,
      "invalid_prompt",
    );
    assert.equal(instance.translateError(auth, { streaming: false }).status, 401);
  });

  test("a started Claude Code stream gets an in-stream error frame", () => {
    const { instance } = prepared("messages", "responses");
    const frame = instance.translateError(chat429, { streaming: true, started: true });
    assert.equal(typeof frame, "string");
    const [event] = parseSseText(frame);
    assert.equal(event.event, "error");
    assert.equal(event.data.error.type, "rate_limit_error");
  });

  test("secrets never reach the client", () => {
    const { instance } = prepared("messages", "chat");
    const leaky = {
      status: 500,
      body: { error: { message: `upstream key ${SECRET} failed` } },
    };
    const rendered = instance.translateError(leaky, { streaming: true });
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
    const streamed = instance.buildUpstream(body, {});
    assert.equal(streamed.ok, false);
    assert.equal(streamed.error.status, 200);
    const { response } = assertResponsesStream(streamed.error.body);
    assert.equal(response.error.code, "invalid_prompt");
    const plain = instance.buildUpstream({ ...body, stream: false }, {});
    assert.equal(plain.error.status, 400);
    assert.equal(plain.error.body.error.type, "invalid_request_error");
  });

  test("malformed Claude Code body → 400 invalid_request_error", () => {
    const instance = translator("messages", "chat");
    const built = instance.buildUpstream(
      { model: "m", messages: "nope", stream: true },
      {},
    );
    assert.equal(built.ok, false);
    assert.equal(built.error.status, 400);
    assert.equal(built.error.body.error.type, "invalid_request_error");
    assert.equal(instance.diagnostics().dropped["request.invalid"], 1);
  });

  test("empty conversation toward Messages → invalidRequest, not a throw", () => {
    const instance = translator("responses", "messages");
    const built = instance.buildUpstream({ model: "m", input: [], stream: false }, {});
    assert.equal(built.ok, false);
    assert.equal(built.error.status, 400);
    assert.match(built.error.body.error.message, /no message is left/);
  });

  test("image input to a model without images is rejected", () => {
    const instance = translator("messages", "chat", {
      model: { ...MODEL, images: false },
    });
    const body = clientBody("clients/claude-code/image.json");
    const built = instance.buildUpstream({ ...body, stream: false }, {});
    assert.equal(built.ok, false);
    assert.equal(built.error.status, 400);
    assert.match(built.error.body.error.message, /image/);
    const codex = translator("responses", "messages", {
      model: { ...MODEL, images: false },
    });
    assert.equal(
      codex.buildUpstream(clientBody("clients/codex/image.json"), {}).ok,
      false,
    );
  });
});

describe("keepalive, ids and diagnostics", () => {
  test("keepalive matches the client protocol", () => {
    const messages = prepared("messages", "chat").instance;
    assert.equal(messages.keepalive(), 'event: ping\ndata: {"type":"ping"}\n\n');
    const responses = prepared("responses", "chat").instance;
    const [frame] = parseSseText(responses.keepalive());
    assert.equal(frame.event, "response.in_progress");
    assert.equal(frame.data.response.id, "req_fixed");
  });

  test("response ids are deterministic per session and request", () => {
    const ids = () => {
      const instance = translator("responses", "chat");
      const body = clientBody("clients/codex/text.json");
      return [1, 2].map(() => {
        const built = instance.buildUpstream(body, {});
        return parseSseText(built.exchange.keepalive())[0].data.response.id;
      });
    };
    const first = ids();
    assert.deepEqual(ids(), first);
    assert.notEqual(first[0], first[1]);
    assert.match(first[0], /^resp_[0-9a-f]{8}_1$/);
  });

  test("diagnostics count dropped hints, adjustments and per request", () => {
    const instance = translator("responses", "messages");
    const body = clientBody("clients/codex/text.json");
    instance.buildUpstream(body, {});
    instance.buildUpstream(body, {});
    const { dropped, adjustments, estimatedUsage } = instance.diagnostics();
    assert.equal(dropped["hints.clientMetadata"], 2);
    assert.equal(dropped["tools.web_search"], 2);
    assert.equal(adjustments["cache.autoBreakpoints"], 2);
    assert.equal(estimatedUsage, 0);
  });
});
