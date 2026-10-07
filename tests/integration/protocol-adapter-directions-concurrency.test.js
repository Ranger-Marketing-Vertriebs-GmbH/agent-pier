import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fromChunks, loadFixture } from "../helpers/protocol-adapter.js";
import {
  assertMessagesStream,
  assertResponsesStream,
} from "../helpers/protocol-adapter-shapes.js";
import {
  chatToolStream,
  clientBody,
  randomSplit,
  roundTrip,
  translator,
} from "../helpers/protocol-adapter-directions.js";

/** Drains two async iterables in lock step, one item from each per turn. */
async function interleave(first, second) {
  const outputs = [[], []];
  const iterators = [first, second].map((iterable) => iterable[Symbol.asyncIterator]());
  const done = [false, false];
  while (!done[0] || !done[1]) {
    for (const index of [0, 1]) {
      if (done[index]) continue;
      const step = await iterators[index].next();
      if (step.done) done[index] = true;
      else outputs[index].push(step.value);
    }
  }
  return outputs.map((frames) => frames.join(""));
}

const mappedNames = (built) =>
  new Map(built.request.body.tools.map((tool, index) => [index, tool.function.name]));

describe("one session, several requests", () => {
  test("a subset or reordered tool set keeps earlier name mappings", () => {
    const instance = translator("messages", "chat");
    const body = clientBody("clients/claude-code/mcp.json");
    const first = instance.buildUpstream(body, {}, { requestId: "msg_1" });
    const byName = new Map(
      body.tools.map((tool, index) => [tool.name, mappedNames(first).get(index)]),
    );
    const long = body.tools.find((tool) => tool.name.length > 64);
    const reordered = [long, ...body.tools.filter((tool) => tool !== long)].reverse();
    const subset = { ...body, tools: reordered.filter((_, index) => index % 2 === 0) };
    if (!subset.tools.includes(long)) subset.tools.push(long);
    const second = instance.buildUpstream(subset, {}, { requestId: "msg_2" });
    subset.tools.forEach((tool, index) => {
      assert.equal(second.request.body.tools[index].function.name, byName.get(tool.name));
    });
  });

  test("a later request restores a name registered by another request", async () => {
    const instance = translator("messages", "chat");
    const mcp = clientBody("clients/claude-code/mcp.json");
    const long = mcp.tools.find((tool) => tool.name.length > 64).name;
    const built = instance.buildUpstream(mcp, {}, { requestId: "msg_1" });
    const mapped =
      built.request.body.tools[mcp.tools.findIndex((t) => t.name === long)].function.name;
    // A request without the MCP tool (e.g. a subagent) still sees the mapped name.
    const plain = clientBody("clients/claude-code/text.json");
    const stream = chatToolStream({ id: "call_x", name: mapped, args: "{}" });
    const { text } = await roundTrip(instance, plain, stream, { requestId: "msg_2" });
    const { message } = assertMessagesStream(text);
    assert.equal(message.content[0].name, long);
  });

  test("interleaved Codex exchanges keep their own model, id and include flag", async () => {
    const instance = translator("responses", "messages");
    const base = clientBody("clients/codex/reasoning.json");
    const withInclude = { ...base, model: "client-model-a" };
    const withoutInclude = { ...base, model: "client-model-b", include: [] };
    const a = instance.buildUpstream(withInclude, {}, { requestId: "resp_a", now: 1000 });
    const b = instance.buildUpstream(
      withoutInclude,
      {},
      { requestId: "resp_b", now: 2000 },
    );
    const upstream = loadFixture("upstreams/messages/thinking-text.sse");
    const [textA, textB] = await interleave(
      a.exchange.translateStream(fromChunks(randomSplit(upstream, 1))),
      b.exchange.translateStream(fromChunks(randomSplit(upstream, 2))),
    );
    const streamA = assertResponsesStream(textA);
    const streamB = assertResponsesStream(textB);
    assert.deepEqual(
      [streamA.response.id, streamA.response.model, streamA.response.created_at],
      ["resp_a", "client-model-a", 1],
    );
    assert.deepEqual(
      [streamB.response.id, streamB.response.model, streamB.response.created_at],
      ["resp_b", "client-model-b", 2],
    );
    assert.equal(typeof streamA.items[0].encrypted_content, "string");
    assert.equal(streamB.items[0].encrypted_content, null);
    assert.match(streamA.items[0].id, /resp_a/);
    assert.match(streamB.items[0].id, /resp_b/);
    assert.match(a.exchange.keepalive(), /"id":"resp_a"/);
    assert.match(b.exchange.keepalive(), /"id":"resp_b"/);
  });

  test("interleaved Claude Code exchanges keep their own model and message id", async () => {
    const instance = translator("messages", "chat");
    const base = clientBody("clients/claude-code/text.json");
    const main = instance.buildUpstream(
      { ...base, model: "main-model" },
      {},
      { requestId: "msg_main" },
    );
    const side = instance.buildUpstream(
      { ...base, model: "small-model" },
      {},
      { requestId: "msg_side" },
    );
    const upstream = loadFixture("upstreams/chat/text.sse");
    const [textMain, textSide] = await interleave(
      main.exchange.translateStream(fromChunks(randomSplit(upstream, 3))),
      side.exchange.translateStream(fromChunks(randomSplit(upstream, 4))),
    );
    const first = assertMessagesStream(textMain).message;
    const second = assertMessagesStream(textSide).message;
    assert.deepEqual([first.id, first.model], ["msg_main", "main-model"]);
    assert.deepEqual([second.id, second.model], ["msg_side", "small-model"]);
  });
});
