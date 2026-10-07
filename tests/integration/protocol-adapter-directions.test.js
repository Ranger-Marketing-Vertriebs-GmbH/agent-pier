import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTranslator } from "../../server/features/protocol-adapter/translate.js";
import { decodeCarrier } from "../../server/features/protocol-adapter/carrier.js";
import { fixtureList, loadFixture } from "../helpers/protocol-adapter.js";
import {
  assertChatRequest,
  assertMessagesRequest,
  assertMessagesStream,
  assertResponsesRequest,
  assertResponsesStream,
} from "../helpers/protocol-adapter-shapes.js";
import {
  CLIENT_DIRS,
  DIRECTIONS,
  MODEL,
  clientBody,
  clientHeaders,
  roundTrip,
  translator,
  REQ,
} from "../helpers/protocol-adapter-directions.js";

const SEEDS = [0, 1, 2, 3, 4, 5, 6, 7];
const VALIDATORS = {
  messages: (request) => assertMessagesRequest(request),
  responses: (request) => {
    assert.equal(request.path, "/responses");
    assertResponsesRequest(request.body);
  },
  chat: (request) => {
    assert.equal(request.path, "/chat/completions");
    assertChatRequest(request.body);
  },
};
const CLIENT_HINTS = [
  "device_id",
  "x-codex-turn-metadata",
  "installation_id",
  "claude-code-20250219",
  "context_management",
  "clear_thinking",
  "client_metadata",
];
const BASE_REQUEST = {
  messages: "clients/claude-code/text.json",
  responses: "clients/codex/text.json",
};
// Streams that must end in the client's in-stream error. Claude Code declares no custom
// tools, so a Responses `custom_tool_call` cannot be expressed and fails cleanly.
const EXPECTED_FAILURES = new Set([
  "messages:upstreams/responses/custom-tool-call.sse",
  "messages:upstreams/responses/failed-context-length.sse",
  "responses:upstreams/messages/error-overloaded.sse",
]);
const STREAM_CHECKS = {
  messages: assertMessagesStream,
  responses: assertResponsesStream,
};

describe("createTranslator", () => {
  test("rejects native routes and unknown protocols", () => {
    for (const protocol of ["messages", "responses"]) {
      assert.throws(
        () => createTranslator({ client: protocol, upstream: protocol, model: MODEL }),
        TypeError,
      );
    }
    assert.throws(
      () => createTranslator({ client: "chat", upstream: "messages" }),
      TypeError,
    );
    assert.throws(
      () => createTranslator({ client: "messages", upstream: "x" }),
      TypeError,
    );
  });
});

for (const { client, upstream } of DIRECTIONS) {
  describe(`${client} client ← ${upstream} upstream`, () => {
    for (const path of fixtureList(CLIENT_DIRS[client])) {
      test(`request ${path} builds a valid upstream request without client hints`, () => {
        const instance = translator(client, upstream);
        const built = instance.buildUpstream(clientBody(path), clientHeaders(path), REQ);
        assert.equal(built.ok, true);
        VALIDATORS[upstream](built.request);
        assert.equal(built.request.body.model, "upstream-model");
        assert.equal(built.request.body.stream, true);
        if (upstream === "chat") assert.ok(!("thinking" in built.request.body));
        const serialized = JSON.stringify(built.request);
        for (const hint of CLIENT_HINTS) {
          assert.ok(!serialized.includes(hint), `${hint} is not forwarded`);
        }
        const headerNames = Object.keys(built.request.headers).sort();
        assert.deepEqual(
          headerNames,
          upstream === "messages"
            ? ["anthropic-version", "content-type"]
            : ["content-type"],
        );
        assert.ok(Array.isArray(built.dropped));
        assert.ok(built.dropped.some((name) => name.startsWith("hints.")));
      });
    }

    for (const path of fixtureList(`upstreams/${upstream}`)) {
      if (!path.endsWith(".sse")) continue;
      test(`stream ${path} translates under random chunk splits`, async () => {
        const upstreamText = loadFixture(path);
        const outputs = [];
        for (const seed of SEEDS) {
          const instance = translator(client, upstream);
          const { text } = await roundTrip(
            instance,
            clientBody(BASE_REQUEST[client]),
            upstreamText,
            {
              seed,
            },
          );
          const result = STREAM_CHECKS[client](text);
          const failed =
            client === "messages"
              ? Boolean(result.error)
              : result.response.status === "failed";
          assert.equal(
            failed,
            EXPECTED_FAILURES.has(`${client}:${path}`),
            "terminal outcome",
          );
          outputs.push(text);
        }
        for (const text of outputs)
          assert.equal(text, outputs[0], "split-independent output");
      });
    }
  });
}

const run = async (
  client,
  upstream,
  fixture,
  body = clientBody(BASE_REQUEST[client]),
) => {
  const instance = translator(client, upstream);
  const { text } = await roundTrip(instance, body, loadFixture(fixture), { seed: 3 });
  return { instance, text };
};

describe("stream details", () => {
  test("Messages ← Chat: parallel tool calls keep ids and names", async () => {
    const { text } = await run(
      "messages",
      "chat",
      "upstreams/chat/parallel-tool-calls.sse",
    );
    const { message } = assertMessagesStream(text);
    const uses = message.content.filter((block) => block.type === "tool_use");
    assert.deepEqual(
      uses.map((use) => [use.id, use.name, use.input]),
      [
        ["call_fixtureA", "read_file", { path: "a.txt" }],
        ["call_fixtureB", "read_file", { path: "b.txt" }],
      ],
    );
    assert.equal(message.stop_reason, "tool_use");
  });

  test("Messages ← Chat without usage: estimated usage is counted", async () => {
    const { instance, text } = await run("messages", "chat", "upstreams/chat/text.sse");
    const { message } = assertMessagesStream(text);
    assert.ok(message.usage.input_tokens > 0, "estimated from the request size");
    assert.equal(instance.diagnostics().estimatedUsage, 1);
  });

  test("Messages ← Responses: reasoning carries a responses carrier", async () => {
    const { text } = await run(
      "messages",
      "responses",
      "upstreams/responses/reasoning-summary.sse",
    );
    const { message } = assertMessagesStream(text);
    const thinking = message.content.find((block) => block.type === "thinking");
    assert.equal(decodeCarrier(thinking.signature).origin, "responses");
  });

  test("Messages ← Responses: failed context length becomes the compaction wording", async () => {
    const { text } = await run(
      "messages",
      "responses",
      "upstreams/responses/failed-context-length.sse",
    );
    const { error } = assertMessagesStream(text);
    assert.equal(error.type, "invalid_request_error");
    assert.match(error.message, /^prompt is too long/);
  });

  test("Messages ← Responses: max_output_tokens becomes max_tokens", async () => {
    const { text } = await run(
      "messages",
      "responses",
      "upstreams/responses/incomplete-max-output-tokens.sse",
    );
    assert.equal(assertMessagesStream(text).message.stop_reason, "max_tokens");
  });

  test("Responses ← Messages: thinking becomes reasoning with a messages carrier", async () => {
    const { text } = await run(
      "responses",
      "messages",
      "upstreams/messages/thinking-text.sse",
    );
    const { items, response } = assertResponsesStream(text);
    assert.equal(items[0].type, "reasoning");
    const carrier = decodeCarrier(items[0].encrypted_content);
    assert.equal(carrier.origin, "messages");
    assert.equal(
      JSON.parse(carrier.payload).t,
      "The user wants a greeting. Answer briefly.",
    );
    assert.equal(response.model, "qwen3-coder:30b", "client model echoed");
    assert.equal(response.created_at, 1791331200);
  });

  test("Responses ← Messages: in-stream overload fails retryably", async () => {
    const { text } = await run(
      "responses",
      "messages",
      "upstreams/messages/error-overloaded.sse",
    );
    const { response } = assertResponsesStream(text);
    assert.equal(response.status, "failed");
    assert.equal(response.error.code, "server_error");
  });

  test("Responses ← Chat: length is completed, not incomplete", async () => {
    const { text } = await run("responses", "chat", "upstreams/chat/length.sse");
    assert.equal(assertResponsesStream(text).response.status, "completed");
  });

  test("Responses ← Chat: reasoning_content becomes a reasoning item", async () => {
    const { text } = await run(
      "responses",
      "chat",
      "upstreams/chat/reasoning-content.sse",
    );
    const { items } = assertResponsesStream(text);
    assert.equal(items[0].type, "reasoning");
    assert.ok(items[0].summary[0].text.length > 0);
  });

  test("think tags are extracted only when enabled", async () => {
    const upstreamText = loadFixture("upstreams/chat/think-inline.sse");
    const body = clientBody(BASE_REQUEST.responses);
    const on = await roundTrip(
      translator("responses", "chat", { thinkTagExtraction: true }),
      body,
      upstreamText,
      { seed: 5 },
    );
    assert.equal(assertResponsesStream(on.text).items[0].type, "reasoning");
    const off = await roundTrip(translator("responses", "chat"), body, upstreamText, {
      seed: 5,
    });
    assert.ok(
      assertResponsesStream(off.text).items.every((item) => item.type === "message"),
    );
  });

  test("malformed upstream SSE ends in the client's in-stream error", async () => {
    const broken =
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: {oops\n\n';
    const messages = await roundTrip(
      translator("messages", "chat"),
      clientBody(BASE_REQUEST.messages),
      broken,
    );
    assert.ok(assertMessagesStream(messages.text).error);
    const responses = await roundTrip(
      translator("responses", "chat"),
      clientBody(BASE_REQUEST.responses),
      broken,
    );
    assert.equal(assertResponsesStream(responses.text).response.status, "failed");
  });
});

describe("non-streaming responses", () => {
  test("Responses ← Messages: non-stream Message becomes a Response object", async () => {
    const instance = translator("responses", "messages");
    const body = { ...clientBody(BASE_REQUEST.responses), stream: false };
    const built = instance.buildUpstream(body, {}, { requestId: "resp_fixed" });
    assert.equal(built.request.body.stream, false);
    const upstream = loadFixture("upstreams/messages/non-stream.json");
    const response = await built.exchange.translateResponse(upstream.body);
    assert.equal(response.id, "resp_fixed");
    assert.equal(response.status, "completed");
    assert.ok(response.output.some((item) => item.type === "function_call"));
  });

  test("an error body rejects with the rendered client error", async () => {
    const instance = translator("messages", "chat");
    const body = { ...clientBody(BASE_REQUEST.messages), stream: false };
    const built = instance.buildUpstream(body, {}, REQ);
    await assert.rejects(
      built.exchange.translateResponse({
        error: { message: `bad key ${"sk-upstream-secret-0123456789abcdef"}` },
      }),
      (error) => {
        assert.equal(error.name, "AdapterUpstreamError");
        assert.equal(error.clientError.body.type, "error");
        assert.ok(!JSON.stringify(error.clientError).includes("sk-upstream-secret"));
        return true;
      },
    );
  });

  test("a malformed body rejects with a rendered server error, not a raw TypeError", async () => {
    const instance = translator("messages", "chat");
    const body = { ...clientBody(BASE_REQUEST.messages), stream: false };
    const built = instance.buildUpstream(body, {}, REQ);
    const call = {
      id: "c1",
      type: "function",
      function: { name: "Bash", arguments: "{bad" },
    };
    const malformed = {
      id: "chatcmpl-bad",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [call] },
          finish_reason: "tool_calls",
        },
      ],
    };
    await assert.rejects(built.exchange.translateResponse(malformed), (error) => {
      assert.equal(error.name, "AdapterUpstreamError");
      assert.equal(error.error.kind, "server");
      assert.equal(error.clientError.status, 500);
      assert.equal(error.clientError.body.error.type, "api_error");
      return true;
    });
    assert.equal(instance.diagnostics().errors["response.invalid"], 1);
  });
});
