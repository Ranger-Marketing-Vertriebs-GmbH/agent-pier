import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildMessagesRequest,
  parseMessagesStream,
} from "../../../server/features/protocol-adapter/upstream-messages.js";
import {
  emitResponsesResponse,
  parseResponsesRequest,
} from "../../../server/features/protocol-adapter/client-responses.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { createSseParser } from "../../../server/features/protocol-adapter/sse.js";
import { collect, loadFixture } from "../../helpers/protocol-adapter.js";

const SIGNATURE = "EqQBCkYIBxgCKkBfixtureSignature0123456789abcdefghijklmnop==";
const THINKING = "The user wants a greeting. Answer briefly.";

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 128 }),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "claude-upstream",
    sessionKey: "session-1",
    ...overrides,
  };
}

async function* sseEvents(text) {
  const parser = createSseParser();
  yield* parser.push(text);
  yield* parser.end();
}

async function* fromArray(items) {
  for (const item of items) yield item;
}

/** Messages upstream → IR → Codex response → next Codex request → IR. */
async function codexFollowUp(fixture, mutate) {
  const events = await collect(
    parseMessagesStream(sseEvents(loadFixture(fixture)), context()),
  );
  const response = await emitResponsesResponse(fromArray(events), {
    model: "gpt-client",
    responseId: "resp_test",
    includeEncrypted: true,
  });
  const output = response.output.map((item) => mutate(structuredClone(item)));
  const { ir } = parseResponsesRequest({
    model: "gpt-client",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ...output,
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
    ],
    reasoning: { effort: "high", summary: "auto" },
    store: false,
    stream: true,
  });
  return ir;
}

describe("Messages thinking replay through Codex", () => {
  test("a summarized block is replayed byte-exact although Codex edits the text", async () => {
    const ir = await codexFollowUp("upstreams/messages/thinking-text.sse", (item) => {
      if (item.type === "reasoning") {
        item.summary = [{ type: "summary_text", text: "Edited summary." }];
      }
      return item;
    });
    const reasoning = ir.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "reasoning");
    assert.equal(reasoning.summary, "Edited summary.");
    const { body } = buildMessagesRequest(ir, context());
    assert.deepEqual(body.messages[1].content[0], {
      type: "thinking",
      thinking: THINKING,
      signature: SIGNATURE,
    });
  });
});

describe("manual thinking in a tool loop", () => {
  const ir = (assistantParts) => ({
    model: "client-model",
    system: [],
    messages: [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: assistantParts },
      {
        role: "user",
        parts: [
          {
            type: "toolResult",
            callId: "call_a",
            parts: [{ type: "text", text: "ok" }],
            isError: false,
          },
        ],
      },
    ],
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: null,
    sampling: { maxOutputTokens: null, temperature: null, topP: null, stop: [] },
    thinking: { mode: "enabled", budgetTokens: 4096 },
    output: null,
    cache: { key: null },
    stream: true,
  });
  const call = {
    type: "toolCall",
    id: "call_a",
    name: "exec_command",
    kind: "function",
    input: "{}",
  };

  test("is omitted when the assistant tool-use turn has no leading thinking", () => {
    const built = buildMessagesRequest(ir([call]), context());
    assert.equal(built.body.thinking, undefined);
    assert.ok(built.adjustments.includes("thinking.omittedNoLeadingBlock"));
  });

  test("is kept when a messages-origin thinking block leads the turn", async () => {
    const [carrierEvent] = (
      await collect(
        parseMessagesStream(
          sseEvents(loadFixture("upstreams/messages/thinking-text.sse")),
          context(),
        ),
      )
    ).filter((event) => event.type === "reasoningCarrier");
    const parts = [{ type: "reasoning", carrier: carrierEvent.carrier }, call];
    const built = buildMessagesRequest(ir(parts), context());
    assert.deepEqual(built.body.thinking, { type: "enabled", budget_tokens: 4096 });
  });

  test("adaptive thinking is unchanged", () => {
    const request = { ...ir([call]), thinking: { mode: "adaptive", effort: "low" } };
    const built = buildMessagesRequest(request, context());
    assert.equal(built.body.thinking.type, "adaptive");
  });
});

describe("request guards", () => {
  test("schemas keep the client's property order", () => {
    const schema = {
      type: "object",
      properties: { zeta: { type: "string" }, alpha: { type: "string" } },
      required: ["zeta"],
    };
    const { body } = buildMessagesRequest(
      {
        model: "m",
        system: [],
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "t", kind: "function", schema }],
        toolChoice: "auto",
        parallelToolCalls: null,
        sampling: { maxOutputTokens: null, temperature: null, topP: null, stop: [] },
        thinking: null,
        output: { format: "json_schema", name: "o", schema },
        cache: { key: null },
        stream: false,
      },
      context(),
    );
    assert.deepEqual(Object.keys(body.tools[0].input_schema.properties), [
      "zeta",
      "alpha",
    ]);
    assert.deepEqual(Object.keys(body.output_config.format.schema.properties), [
      "zeta",
      "alpha",
    ]);
  });

  test("a request without sendable messages is refused", () => {
    assert.throws(
      () =>
        buildMessagesRequest(
          {
            model: "m",
            system: [{ type: "text", text: "only system" }],
            messages: [{ role: "user", parts: [{ type: "text", text: "" }] }],
            tools: [],
            toolChoice: "auto",
            parallelToolCalls: null,
            sampling: { maxOutputTokens: null, temperature: null, topP: null, stop: [] },
            thinking: null,
            output: null,
            cache: { key: null },
            stream: true,
          },
          context(),
        ),
      { name: "TypeError", message: /request\.messages/ },
    );
  });
});
