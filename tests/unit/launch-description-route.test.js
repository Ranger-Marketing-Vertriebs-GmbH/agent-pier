import test from "node:test";
import assert from "node:assert/strict";
import { launchTarget } from "../../server/features/providers/launch-description.js";

const endpoint = {
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  anthropicBaseUrl: "http://127.0.0.1:11435",
  protocols: { messages: true, responses: true, chatCompletions: true },
};
const account = (tool, id = "endpoint") => ({ tool, provider: { id } });

test("endpoint launch targets carry the resolved route", () => {
  assert.deepEqual(launchTarget(account("claude"), endpoint).route, {
    mode: "native",
    source: "messages",
  });
  assert.deepEqual(
    launchTarget(account("claude"), {
      ...endpoint,
      protocols: { messages: false, responses: true, chatCompletions: true },
      routing: { claude: "adapter:chatCompletions" },
    }).route,
    { mode: "adapter", source: "chatCompletions" },
  );
  assert.deepEqual(launchTarget(account("opencode"), endpoint).route, {
    mode: "native",
    source: "chatCompletions",
  });
});

test("a removed connection yields no route instead of throwing", () => {
  assert.equal(launchTarget(account("codex"), undefined).route, null);
});

test("catalog launch targets are native on the tool's protocol", () => {
  assert.deepEqual(launchTarget(account("claude", "zai")).route, {
    mode: "native",
    source: "messages",
  });
  assert.deepEqual(launchTarget(account("codex", "zai")).route, {
    mode: "native",
    source: "responses",
  });
});
