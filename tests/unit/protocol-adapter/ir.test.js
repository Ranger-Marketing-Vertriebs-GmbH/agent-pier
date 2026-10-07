import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIrEvent,
  assertIrRequest,
} from "../../../server/features/protocol-adapter/ir.js";

function request(overrides = {}) {
  return {
    model: "m",
    system: [{ type: "text", text: "sys", cache: "ephemeral" }],
    messages: [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "system", parts: [{ type: "text", text: "mid" }] },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "t", carrier: "ap1.messages.e30" },
          {
            type: "toolCall",
            id: "c1",
            name: "read",
            namespace: "mcp",
            kind: "function",
            input: "{}",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "toolResult",
            callId: "c1",
            isError: false,
            parts: [
              { type: "text", text: "ok" },
              { type: "image", mediaType: "image/png", data: "AAAA" },
            ],
          },
        ],
      },
    ],
    tools: [
      { name: "read", namespace: "mcp", description: "d", kind: "function", schema: {} },
      {
        name: "apply_patch",
        description: "p",
        kind: "custom",
        grammar: { syntax: "lark", definition: "start: /.+/" },
      },
      {
        name: "web_search",
        description: "",
        kind: "hosted",
        hostedType: "web_search",
        raw: { type: "web_search" },
      },
    ],
    toolChoice: "auto",
    parallelToolCalls: null,
    sampling: { maxOutputTokens: null, temperature: 0.5, topP: undefined, stop: [] },
    thinking: { mode: "adaptive", effort: "high", display: "omitted" },
    output: { format: "text" },
    cache: { key: null },
    stream: true,
    hints: {},
    ...overrides,
  };
}

test("a complete IR request passes", () => {
  const ir = request();
  assert.equal(assertIrRequest(ir), ir);
});

test("optional request fields may be absent or null", () => {
  assertIrRequest(
    request({
      thinking: null,
      output: undefined,
      cache: undefined,
      hints: undefined,
      parallelToolCalls: true,
      toolChoice: { name: "read", namespace: "mcp" },
    }),
  );
  assertIrRequest(request({ thinking: { mode: "between_tools", effort: "low" } }));
  assertIrRequest(
    request({ output: { format: "json_schema", name: "o", schema: {}, strict: true } }),
  );
});

function assertPath(fn, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TypeError);
    assert.ok(error.message.includes(path), `${error.message} should include ${path}`);
    return true;
  });
}

test("invalid requests throw TypeError with a path", () => {
  assertPath(() => assertIrRequest(null), "request");
  assertPath(() => assertIrRequest(request({ model: 3 })), "request.model");
  assertPath(() => assertIrRequest(request({ stream: "yes" })), "request.stream");
  assertPath(
    () => assertIrRequest(request({ messages: [{ role: "tool", parts: [] }] })),
    "request.messages[0].role",
  );
  const bad = request();
  bad.messages[3].parts[0].parts[1] = { type: "image", mediaType: "image/png" };
  assertPath(() => assertIrRequest(bad), "request.messages[3].parts[0].parts[1]");
  const badCall = request();
  badCall.messages[2].parts[1].kind = "hosted";
  assertPath(() => assertIrRequest(badCall), "request.messages[2].parts[1].kind");
  assertPath(
    () => assertIrRequest(request({ tools: [{ name: "x", kind: "weird" }] })),
    "request.tools[0].kind",
  );
  assertPath(
    () =>
      assertIrRequest(
        request({ tools: [{ name: "x", kind: "hosted", hostedType: "t", raw: "x" }] }),
      ),
    "request.tools[0].raw",
  );
  assertPath(
    () =>
      assertIrRequest(request({ tools: [{ name: "x", kind: "custom", grammar: "g" }] })),
    "request.tools[0].grammar",
  );
  const badDetail = request();
  badDetail.messages[3].parts[0].parts[1].detail = 3;
  assertPath(
    () => assertIrRequest(badDetail),
    "request.messages[3].parts[0].parts[1].detail",
  );
  assertPath(() => assertIrRequest(request({ toolChoice: "any" })), "request.toolChoice");
  assertPath(
    () => assertIrRequest(request({ thinking: { mode: "on" } })),
    "request.thinking.mode",
  );
  assertPath(
    () => assertIrRequest(request({ thinking: { mode: "adaptive", display: "full" } })),
    "request.thinking.display",
  );
  assertPath(
    () => assertIrRequest(request({ sampling: { maxOutputTokens: -1, stop: [] } })),
    "request.sampling.maxOutputTokens",
  );
  assertPath(
    () => assertIrRequest(request({ output: { format: "json_schema" } })),
    "request.output.name",
  );
  assertPath(
    () => assertIrRequest(request({ system: [{ type: "text", text: "s", cache: "x" }] })),
    "request.system[0].cache",
  );
});

test("valid events pass", () => {
  const events = [
    { type: "start", id: "r1", model: "m" },
    { type: "blockStart", index: 0, kind: "text" },
    {
      type: "blockStart",
      index: 1,
      kind: "toolCall",
      toolCall: { id: "c", name: "n", namespace: "ns", kind: "custom" },
    },
    { type: "textDelta", index: 0, text: "x" },
    { type: "reasoningDelta", index: 2, summary: "s" },
    { type: "reasoningCarrier", index: 2, carrier: "ap1.chat.e30" },
    { type: "toolInputDelta", index: 1, fragment: "{" },
    { type: "blockStop", index: 0 },
    {
      type: "usage",
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      estimated: false,
    },
    { type: "stop", reason: "stopSequence", stopSequence: "END" },
    {
      type: "error",
      error: { kind: "rateLimit", status: 429, message: "slow", retryAfter: 3 },
    },
  ];
  for (const event of events) assert.equal(assertIrEvent(event), event);
});

test("invalid events throw TypeError with a path", () => {
  assertPath(() => assertIrEvent({ type: "nope" }), "event.type");
  assertPath(
    () => assertIrEvent({ type: "textDelta", index: -1, text: "" }),
    "event.index",
  );
  assertPath(
    () => assertIrEvent({ type: "blockStart", index: 0, kind: "toolCall" }),
    "event.toolCall",
  );
  assertPath(() => assertIrEvent({ type: "stop", reason: "done" }), "event.reason");
  assertPath(
    () => assertIrEvent({ type: "usage", input: 1, output: "2" }),
    "event.output",
  );
  assertPath(
    () =>
      assertIrEvent({ type: "error", error: { kind: "boom", status: 500, message: "" } }),
    "event.error.kind",
  );
});

test("tool schema, strict and grammar fields and error status are validated", () => {
  const tool = (fields) =>
    request({ tools: [{ name: "x", kind: "function", ...fields }] });
  assertPath(() => assertIrRequest(tool({ schema: "s" })), "request.tools[0].schema");
  assertPath(() => assertIrRequest(tool({ strict: "yes" })), "request.tools[0].strict");
  assertPath(
    () => assertIrRequest(tool({ kind: "custom", grammar: { syntax: "lark" } })),
    "request.tools[0].grammar.definition",
  );
  assertPath(
    () => assertIrRequest(tool({ kind: "custom", grammar: { definition: "d" } })),
    "request.tools[0].grammar.syntax",
  );
  assert.ok(assertIrRequest(tool({ schema: { type: "object" }, strict: true })));
  assertPath(
    () => assertIrRequest(tool({ cache: "ephemeral", cacheTtl: "2d" })),
    "request.tools[0].cacheTtl",
  );
  assert.ok(assertIrRequest(tool({ cache: "ephemeral", cacheTtl: "1h" })));
  const error = (status) => ({
    type: "error",
    error: { kind: "server", status, message: "" },
  });
  assertPath(() => assertIrEvent(error("500")), "event.error.status");
  assert.ok(assertIrEvent(error(undefined)));
});
