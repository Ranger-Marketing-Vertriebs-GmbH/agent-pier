import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator } from "../../../server/features/protocol-adapter/translate.js";
import { collect, fromChunks, loadFixture } from "../../helpers/protocol-adapter.js";

const claudeBody = () => loadFixture("clients/claude-code/text.json").body;
const codexBody = () => loadFixture("clients/codex/text.json").body;

function translator(client, upstream) {
  return createTranslator({ client, upstream, model: "m", sessionKey: "s" });
}

async function exchange(translator, body, fixture, requestId) {
  const built = translator.buildUpstream({ ...body, stream: true }, {}, { requestId });
  assert.equal(built.ok, true);
  const chunks = fromChunks([loadFixture(fixture)]);
  return (await collect(built.exchange.translateStream(chunks))).join("");
}

test("cacheReadTokens sums the cached tokens over exchanges", async () => {
  const t = translator("messages", "chat");
  assert.equal(t.diagnostics().cacheReadTokens, 0);
  await exchange(t, claudeBody(), "upstreams/chat/usage-cached.sse", "msg_1");
  assert.equal(t.diagnostics().cacheReadTokens, 3072);
  await exchange(t, claudeBody(), "upstreams/chat/usage-cached.sse", "msg_2");
  assert.equal(t.diagnostics().cacheReadTokens, 6144);
  // An exchange without cached tokens adds nothing.
  await exchange(t, claudeBody(), "upstreams/chat/text.sse", "msg_3");
  assert.equal(t.diagnostics().cacheReadTokens, 6144);
});

test("cumulative usage reported twice in one exchange is counted once", async () => {
  // Messages upstreams repeat the cumulative usage in message_start and message_delta.
  const fixture = "upstreams/messages/text.sse";
  assert.equal(loadFixture(fixture).match(/"cache_read_input_tokens":2048/g).length, 2);
  const t = translator("responses", "messages");
  const frames = await exchange(t, codexBody(), fixture, "resp_1");
  assert.match(frames, /"cached_tokens":2048/);
  assert.equal(t.diagnostics().cacheReadTokens, 2048);
});

test("Responses cached usage counts its cached tokens", async () => {
  const t = translator("messages", "responses");
  await exchange(t, claudeBody(), "upstreams/responses/cached-usage.sse", "msg_1");
  assert.equal(t.diagnostics().cacheReadTokens, 3072);
});
