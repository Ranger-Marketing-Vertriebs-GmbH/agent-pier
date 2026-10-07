import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeCarrier } from "../../server/features/protocol-adapter/carrier.js";
import {
  assertChatRequest,
  assertMessagesRequest,
  assertMessagesStream,
  assertResponsesRequest,
  assertResponsesStream,
} from "../helpers/protocol-adapter-shapes.js";
import {
  chatToolStream,
  clientBody,
  messagesThinkingToolStream,
  responsesReasoningToolStream,
  roundTrip,
  translator,
} from "../helpers/protocol-adapter-directions.js";

const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n";
const SIGNATURE = "EqQBCkYIBxgCKkBloopSignature0123456789==";

/** Codex input items replaying a completed response (as Codex sends them, ids kept). */
function replayItems(items, outputs) {
  const replay = items.map((item) => {
    if (item.type === "reasoning") {
      return { ...item, summary: [{ type: "summary_text", text: "edited summary" }] };
    }
    const { status: _status, ...rest } = item;
    return rest;
  });
  return [...replay, ...outputs];
}

/** Claude Code follow-up: assistant content as received, then tool results. */
function claudeFollowUp(body, message, results) {
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: message.content },
      { role: "user", content: results },
    ],
  };
}

const lastAssistant = (messages) => messages.findLast((m) => m.role === "assistant");

describe("multi-turn tool loops", () => {
  test("Codex ↔ Messages: exact thinking replay and mapped call ids", async () => {
    const instance = translator("responses", "messages");
    const first = clientBody("clients/codex/function-call.json");
    const stream = messagesThinkingToolStream({
      thinking: "Plan: list the files.",
      signature: SIGNATURE,
      id: "toolu_up_1",
      name: "exec_command",
      input: { cmd: "ls" },
    });
    const { text } = await roundTrip(instance, first, stream, { seed: 4 });
    const { items } = assertResponsesStream(text);
    assert.deepEqual(
      items.map((item) => item.type),
      ["reasoning", "function_call"],
    );
    assert.equal(decodeCarrier(items[0].encrypted_content).origin, "messages");
    assert.equal(items[1].call_id, "toolu_up_1");
    assert.equal(items[1].name, "exec_command");

    const second = {
      ...first,
      input: [
        ...first.input,
        ...replayItems(items, [
          { type: "function_call_output", call_id: "toolu_up_1", output: "a.txt" },
        ]),
      ],
    };
    const built = instance.buildUpstream(second, {});
    assert.equal(built.ok, true);
    assertMessagesRequest(built.request);
    const assistant = lastAssistant(built.request.body.messages);
    assert.deepEqual(assistant.content[0], {
      type: "thinking",
      thinking: "Plan: list the files.",
      signature: SIGNATURE,
    });
    assert.equal(assistant.content[1].id, "toolu_up_1");
    assert.equal(assistant.content[1].name, "exec_command");
    const results = built.request.body.messages.at(-1).content;
    assert.equal(results[0].tool_use_id, "toolu_up_1");
  });

  test("Claude Code ↔ Chat: reasoning replayed as reasoning_content", async () => {
    const instance = translator("messages", "chat", {
      capabilities: { reasoningReplay: true },
    });
    const first = clientBody("clients/claude-code/tool-call.json");
    const stream = chatToolStream({
      reasoning: "Need to run ls.",
      id: "call_up_1",
      name: "Bash",
      args: '{"command":"ls"}',
    });
    const { text } = await roundTrip(instance, first, stream, { seed: 2 });
    const { message } = assertMessagesStream(text);
    const [thinking, use] = message.content;
    assert.equal(thinking.type, "thinking");
    const carrier = decodeCarrier(thinking.signature);
    assert.deepEqual(carrier, { origin: "chat", payload: "Need to run ls." });
    assert.deepEqual(
      [use.id, use.name, use.input],
      ["call_up_1", "Bash", { command: "ls" }],
    );

    const second = claudeFollowUp(first, message, [
      { type: "tool_result", tool_use_id: "call_up_1", content: "a.txt" },
    ]);
    const built = instance.buildUpstream(second, {});
    assertChatRequest(built.request.body);
    const assistant = lastAssistant(built.request.body.messages);
    assert.equal(assistant.reasoning_content, "Need to run ls.");
    assert.equal(assistant.tool_calls[0].id, "call_up_1");
    assert.equal(assistant.tool_calls[0].function.name, "Bash");
    const tool = built.request.body.messages.find((entry) => entry.role === "tool");
    assert.deepEqual([tool.tool_call_id, tool.content], ["call_up_1", "a.txt"]);

    const plain = translator("messages", "chat");
    const withoutReplay = plain.buildUpstream(second, {});
    assert.ok(
      !("reasoning_content" in lastAssistant(withoutReplay.request.body.messages)),
    );
  });

  test("Claude Code ↔ Responses: encrypted reasoning replayed", async () => {
    const instance = translator("messages", "responses");
    const first = clientBody("clients/claude-code/tool-call.json");
    const stream = responsesReasoningToolStream({
      summary: "Need to run ls.",
      encrypted: "enc-opaque-1",
      call: { call_id: "call_up_2", name: "Bash", arguments: '{"command":"ls"}' },
    });
    const { text } = await roundTrip(instance, first, stream, { seed: 6 });
    const { message } = assertMessagesStream(text);
    const [thinking, use] = message.content;
    assert.deepEqual(decodeCarrier(thinking.signature), {
      origin: "responses",
      payload: "enc-opaque-1",
    });
    assert.equal(use.id, "call_up_2");

    const second = claudeFollowUp(first, message, [
      { type: "tool_result", tool_use_id: "call_up_2", content: "a.txt" },
    ]);
    const built = instance.buildUpstream(second, {});
    assertResponsesRequest(built.request.body);
    const input = built.request.body.input;
    const reasoning = input.find((item) => item.type === "reasoning");
    assert.equal(reasoning.encrypted_content, "enc-opaque-1");
    const call = input.find((item) => item.type === "function_call");
    assert.deepEqual([call.call_id, call.name], ["call_up_2", "Bash"]);
    assert.ok(
      input.indexOf(reasoning) < input.indexOf(call),
      "reasoning precedes the call",
    );
    const output = input.find((item) => item.type === "function_call_output");
    assert.equal(output.call_id, "call_up_2");
  });

  test("Codex ↔ Chat: reasoning carrier replayed with reasoningReplay", async () => {
    const instance = translator("responses", "chat", {
      capabilities: { reasoningReplay: true },
    });
    const first = clientBody("clients/codex/function-call.json");
    const stream = chatToolStream({
      reasoning: "Think first.",
      id: "call_up_3",
      name: "exec_command",
      args: '{"cmd":"ls"}',
    });
    const { text } = await roundTrip(instance, first, stream, { seed: 7 });
    const { items } = assertResponsesStream(text);
    assert.deepEqual(decodeCarrier(items[0].encrypted_content), {
      origin: "chat",
      payload: "Think first.",
    });
    const second = {
      ...first,
      input: [
        ...first.input,
        ...replayItems(items, [
          { type: "function_call_output", call_id: "call_up_3", output: "a.txt" },
        ]),
      ],
    };
    const built = instance.buildUpstream(second, {});
    assertChatRequest(built.request.body);
    const assistant = lastAssistant(built.request.body.messages);
    assert.equal(assistant.reasoning_content, "Think first.");
    assert.equal(assistant.tool_calls[0].id, "call_up_3");
  });

  test("Claude Code ↔ Chat: long MCP names map to one stable short name", async () => {
    const instance = translator("messages", "chat");
    const first = clientBody("clients/claude-code/mcp.json");
    const built = instance.buildUpstream(first, {});
    const long = first.tools.find((tool) => tool.name.length > 64).name;
    const index = first.tools.findIndex((tool) => tool.name === long);
    const mapped = built.request.body.tools[index].function.name;
    assert.ok(mapped.length <= 64 && mapped !== long);
    const stream = chatToolStream({ id: "call_mcp", name: mapped, args: "{}" });
    const { text } = await roundTrip(instance, first, stream);
    const { message } = assertMessagesStream(text);
    assert.equal(message.content[0].name, long, "original name restored");
    const second = claudeFollowUp(first, message, [
      { type: "tool_result", tool_use_id: "call_mcp", content: "docs" },
    ]);
    const next = instance.buildUpstream(second, {});
    assertChatRequest(next.request.body);
    assert.equal(
      lastAssistant(next.request.body.messages).tool_calls[0].function.name,
      mapped,
    );
    assert.equal(next.request.body.tools[index].function.name, mapped, "stable mapping");
  });

  test("Codex ↔ Messages: namespaced MCP tools round trip", async () => {
    const instance = translator("responses", "messages");
    const first = clientBody("clients/codex/mcp.json");
    const built = instance.buildUpstream(first, {});
    const tool = built.request.body.tools.find((entry) => entry.name.startsWith("mcp__"));
    assert.ok(tool, "namespaced tool is flattened");
    const stream = messagesThinkingToolStream({
      thinking: "Use the MCP tool.",
      signature: SIGNATURE,
      id: "toolu_mcp",
      name: tool.name,
      input: {},
    });
    const { text } = await roundTrip(instance, first, stream, { seed: 3 });
    const call = assertResponsesStream(text).items.find(
      (item) => item.type === "function_call",
    );
    assert.equal(`${call.namespace}__${call.name}`, tool.name);
    assert.ok(call.namespace.startsWith("mcp__"));
  });
});

describe("Codex custom tools (apply_patch) through function-only upstreams", () => {
  const expectCustomCall = (text) => {
    const { items } = assertResponsesStream(text);
    const calls = items.filter((item) => item.type.endsWith("_call"));
    assert.deepEqual(
      calls.map((item) => [item.type, item.name, item.input]),
      [["custom_tool_call", "apply_patch", PATCH]],
    );
    return calls[0];
  };

  test("Responses ← Chat: apply_patch reaches Codex as custom_tool_call", async () => {
    const instance = translator("responses", "chat");
    const first = clientBody("clients/codex/apply-patch.json");
    const stream = chatToolStream({
      id: "call_patch",
      name: "apply_patch",
      args: JSON.stringify({ input: PATCH }),
    });
    const { text } = await roundTrip(instance, first, stream, { seed: 5 });
    const call = expectCustomCall(text);
    const second = {
      ...first,
      input: [
        ...first.input,
        {
          type: "custom_tool_call",
          call_id: call.call_id,
          name: "apply_patch",
          input: PATCH,
        },
        { type: "custom_tool_call_output", call_id: call.call_id, output: "Success." },
      ],
    };
    const built = instance.buildUpstream(second, {});
    assertChatRequest(built.request.body);
    const sent = lastAssistant(built.request.body.messages).tool_calls[0];
    assert.equal(sent.function.arguments, JSON.stringify({ input: PATCH }));
  });

  test("Responses ← Messages: apply_patch reaches Codex as custom_tool_call", async () => {
    const instance = translator("responses", "messages");
    const stream = messagesThinkingToolStream({
      thinking: "Write the file.",
      signature: SIGNATURE,
      id: "toolu_patch",
      name: "apply_patch",
      input: { input: PATCH },
    });
    const first = clientBody("clients/codex/apply-patch.json");
    const { text } = await roundTrip(instance, first, stream, { seed: 1 });
    expectCustomCall(text);
  });
});
