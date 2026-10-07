import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseResponsesRequest } from "../../../server/features/protocol-adapter/client-responses.js";

const inputText = (value) => ({ type: "input_text", text: value });
const user = (value) => ({ type: "message", role: "user", content: [inputText(value)] });
const parse = (input, extra = {}) =>
  parseResponsesRequest({ model: "m", input, ...extra });

describe("Codex request parser edge cases", () => {
  test("reasoning content errors name the original index", () => {
    const reasoning = {
      type: "reasoning",
      summary: [],
      content: [
        { type: "other", text: 1 },
        { type: "reasoning_text", text: "ok" },
        { type: "reasoning_text", text: 5 },
      ],
    };
    assert.throws(() => parse([user("hi"), reasoning]), {
      name: "TypeError",
      message: /^input\[1\]\.content\[2\]\.text: expected a string$/,
    });
    const summary = {
      type: "reasoning",
      summary: [{ type: "x" }, { type: "summary_text" }],
    };
    assert.throws(() => parse([user("hi"), summary]), {
      message: /^input\[1\]\.summary\[1\]\.text/,
    });
  });

  test("tool outputs without call_id are counted and skipped", () => {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
      const { ir, dropped } = parse([user("hi"), { type, output: "lost" }]);
      assert.deepEqual(ir.messages, [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);
      assert.deepEqual(dropped, [`input.${type}.call_id`]);
    }
  });

  test("encrypted_function_args on function calls are counted", () => {
    const { ir, dropped } = parse([
      user("hi"),
      {
        type: "function_call",
        call_id: "c1",
        name: "f",
        arguments: "{}",
        encrypted_function_args: ["enc"],
      },
    ]);
    assert.equal(ir.messages[1].parts[0].input, "{}");
    assert.deepEqual(dropped, ["function_call.encrypted_function_args"]);
  });

  test("data URLs with media type parameters are parsed as base64", () => {
    const image = {
      type: "input_image",
      image_url: "data:image/PNG;foo=bar;charset=x;base64,AAAA",
    };
    const { ir } = parse([{ type: "message", role: "user", content: [image] }]);
    assert.deepEqual(ir.messages[0].parts, [
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ]);
  });

  test("agent_message text becomes assistant text; encrypted parts are counted", () => {
    const { ir, dropped } = parse([
      user("hi"),
      {
        type: "agent_message",
        author: "worker",
        recipient: "main",
        content: [
          inputText("found it"),
          { type: "encrypted_content", encrypted_content: "e" },
        ],
      },
    ]);
    assert.deepEqual(ir.messages[1], {
      role: "assistant",
      parts: [{ type: "text", text: "found it" }],
    });
    assert.deepEqual(dropped, ["agent_message.encrypted_content"]);
  });

  test("additional_tools items are merged into the tool list", () => {
    const fn = { type: "function", name: "lookup", parameters: { type: "object" } };
    const custom = { type: "custom", name: "apply_patch" };
    const { ir, dropped } = parse(
      [{ type: "additional_tools", role: "developer", tools: [custom] }, user("hi")],
      { tools: [fn] },
    );
    assert.deepEqual(
      ir.tools.map((tool) => [tool.name, tool.kind]),
      [
        ["lookup", "function"],
        ["apply_patch", "custom"],
      ],
    );
    assert.deepEqual(ir.messages.length, 1);
    assert.deepEqual(dropped, []);
    assert.throws(() => parse([{ type: "additional_tools", tools: "x" }]), {
      message: /^input\[0\]\.tools: expected an array$/,
    });
  });
});
