import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildChatRequest,
  parseChatResponse,
  parseChatStream,
} from "../../../server/features/protocol-adapter/upstream-chat.js";
import { assertIrEvent } from "../../../server/features/protocol-adapter/ir.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { collect } from "../../helpers/protocol-adapter.js";

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 64 }),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "upstream-model",
    sessionKey: "session-1",
    thinkTagExtraction: false,
    ...overrides,
  };
}

const text = (value) => ({ type: "text", text: value });
const system = (value) => ({ role: "system", parts: [text(value)] });
const user = (...parts) => ({ role: "user", parts });
const call = { type: "toolCall", id: "c1", name: "f", kind: "function", input: "{}" };
const assistantCall = { role: "assistant", parts: [call] };
const result = { type: "toolResult", callId: "c1", parts: [text("out")], isError: false };
const tagged = (value) => text(`<system>\n${value}\n</system>`);

function build(messages, capabilities = {}) {
  const ir = {
    model: "m",
    system: [text("base")],
    messages,
    tools: [{ name: "f", kind: "function", schema: {} }],
    toolChoice: "auto",
    parallelToolCalls: null,
    sampling: { maxOutputTokens: null, stop: [] },
    thinking: null,
    stream: true,
  };
  const { messages: out } = buildChatRequest(ir, context({ capabilities })).body;
  const roles = out.map((message) => message.role);
  roles.forEach((role, index) => {
    if (index > 0)
      assert.ok(!(role === "user" && roles[index - 1] === "user"), "alternation");
  });
  return out;
}

describe("mid-conversation system messages (merge by default)", () => {
  test("system between tool_use and tool_result moves after the tool message", () => {
    const out = build([user(text("go")), assistantCall, system("note"), user(result)]);
    assert.deepEqual(
      out.map((message) => message.role),
      ["system", "user", "assistant", "tool", "user"],
    );
    assert.deepEqual(out.at(-1).content, [tagged("note")]);
  });

  test("system before a user turn becomes its leading text part", () => {
    const out = build([
      user(text("a")),
      assistantCall,
      user(result, text("b")),
      system("s"),
      user(text("c")),
    ]);
    assert.deepEqual(out.at(-1), {
      role: "user",
      content: [text("b"), tagged("s"), text("c")],
    });
    const leading = build([
      user(text("a")),
      { role: "assistant", parts: [text("x")] },
      system("s"),
      user(text("c")),
    ]);
    assert.deepEqual(leading.at(-1).content, [tagged("s"), text("c")]);
  });

  test("system as last message: appended to a trailing user, else a new user", () => {
    const afterUser = build([user(text("q")), system("last")]);
    assert.deepEqual(afterUser.at(-1), {
      role: "user",
      content: [text("q"), tagged("last")],
    });
    const afterAssistant = build([
      user(text("q")),
      { role: "assistant", parts: [text("a")] },
      system("last"),
    ]);
    assert.deepEqual(afterAssistant.at(-1), { role: "user", content: [tagged("last")] });
  });

  test("system messages before any turn join the leading system message", () => {
    const out = build([system("more"), user(text("q"))]);
    assert.deepEqual(out[0], { role: "system", content: "base\n\nmore" });
    assert.equal(out.length, 2);
  });

  test('capability systemMessages "inline" keeps role system in place', () => {
    const out = build([user(text("go")), assistantCall, user(result), system("note")], {
      systemMessages: "inline",
    });
    assert.deepEqual(
      out.map((message) => message.role),
      ["system", "user", "assistant", "tool", "system"],
    );
    assert.deepEqual(out.at(-1), { role: "system", content: "note" });
  });
});

async function* events(items) {
  for (const item of items) {
    yield { data: typeof item === "string" ? item : JSON.stringify(item) };
  }
}
const chunk = (delta, extra = {}) => ({
  id: "x",
  model: "m",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});
const finish = (reason) => ({
  id: "x",
  model: "m",
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});

async function parse(items, overrides) {
  const out = await collect(parseChatStream(events(items), context(overrides)));
  for (const event of out) assertIrEvent(event);
  return out;
}

/** Throws when a block receives events after another block started (overlap). */
function assertNoOverlap(out) {
  const open = new Set();
  for (const event of out) {
    if (event.type === "blockStart") {
      if (event.kind !== "toolCall")
        assert.equal(open.size, 0, "text opened inside a call");
      open.add(event.index);
    } else if (event.type === "blockStop") open.delete(event.index);
    else if (event.type === "textDelta" || event.type === "reasoningDelta") {
      assert.ok(open.has(event.index), "delta for an open block");
      assert.equal(open.size, 1, "text deltas while another block is open");
    }
  }
}

describe("Chat stream hardening", () => {
  const toolCall = { index: 0, id: "a", function: { name: "f", arguments: "{}" } };

  for (const prefix of ["\n\n", " <thi", "<think>r</thi"]) {
    test(`held ${JSON.stringify(prefix)} before a tool call never overlaps it`, async () => {
      const out = await parse(
        [
          chunk({ content: prefix }),
          chunk({ tool_calls: [toolCall] }),
          finish("tool_calls"),
          "[DONE]",
        ],
        { thinkTagExtraction: true },
      );
      assertNoOverlap(out);
      const starts = out.filter((event) => event.type === "blockStart");
      if (prefix === "\n\n")
        assert.deepEqual(
          starts.map((event) => event.kind),
          ["toolCall"],
        );
    });
  }

  test("whitespace-only text is dropped, also without extraction", async () => {
    const out = await parse([
      chunk({ content: "\n" }),
      chunk({ tool_calls: [toolCall] }),
      "[DONE]",
    ]);
    assert.deepEqual(
      out.filter((event) => event.type === "blockStart").map((event) => event.kind),
      ["toolCall"],
    );
    const spaced = await parse([
      chunk({ content: " " }),
      chunk({ content: "hi" }),
      "[DONE]",
    ]);
    assert.deepEqual(
      spaced.filter((event) => event.type === "textDelta").map((event) => event.text),
      [" hi"],
    );
  });

  test('"error": null on a normal chunk is not a failure', async () => {
    const out = await parse([chunk({ content: "hi" }, { error: null }), "[DONE]"]);
    assert.ok(!out.some((event) => event.type === "error"));
    assert.equal(out.at(-1).type, "stop");
    const response = parseChatResponse(
      {
        id: "r",
        model: "m",
        error: null,
        choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
      },
      context(),
    );
    assert.equal(response.at(-1).type, "stop");
  });

  test("object arguments are serialized", async () => {
    const objectCall = {
      index: 0,
      id: "a",
      function: { name: "f", arguments: { path: "a.txt" } },
    };
    const out = await parse([chunk({ tool_calls: [objectCall] }), "[DONE]"]);
    const fragments = out.filter((event) => event.type === "toolInputDelta");
    assert.deepEqual(
      fragments.map((event) => event.fragment),
      ['{"path":"a.txt"}'],
    );
  });

  test("index-less tool calls with different ids are separate calls", async () => {
    const out = await parse([
      chunk({ tool_calls: [{ id: "a", function: { name: "f", arguments: '{"x":1}' } }] }),
      chunk({ tool_calls: [{ id: "b", function: { name: "g", arguments: '{"y":2}' } }] }),
      chunk({ tool_calls: [{ function: { arguments: "" } }] }),
      "[DONE]",
    ]);
    const starts = out.filter((event) => event.type === "blockStart");
    assert.deepEqual(
      starts.map((event) => event.toolCall.name),
      ["f", "g"],
    );
  });
});
