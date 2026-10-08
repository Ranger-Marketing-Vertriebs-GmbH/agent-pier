// tests/unit/endpoint-routes-parity.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRoute,
  ROUTE_CHOICES as SERVER_CHOICES,
  libraryProtocol,
} from "../../server/features/providers/endpoint-routing.js";
import { CAPABILITY_DEFAULTS } from "../../server/features/protocol-adapter/capabilities.js";
import {
  ROUTE_CHOICES,
  ROUTE_TOOLS,
  CAPABILITY_FIELDS,
  adapterSources,
  resolveDraftRoute,
  routeOptions,
} from "../../web/features/provider-connections/endpoint-routes.js";

const SOURCES = ["messages", "responses", "chatCompletions"];
function* endpoints() {
  for (let mask = 0; mask < 8; mask++)
    for (const anthropicBaseUrl of ["https://llm.example", ""])
      for (const claude of ROUTE_CHOICES.claude)
        for (const codex of ROUTE_CHOICES.codex)
          for (const opencode of ROUTE_CHOICES.opencode)
            yield {
              openaiBaseUrl: "https://llm.example/v1",
              anthropicBaseUrl,
              protocols: Object.fromEntries(
                SOURCES.map((s, i) => [s, !!(mask & (1 << i))]),
              ),
              routing: { claude, codex, opencode },
            };
}

test("route choices equal the server's", () => {
  assert.deepEqual(ROUTE_CHOICES, SERVER_CHOICES);
});

test("the draft route equals the server route for every protocol set and choice", () => {
  for (const endpoint of endpoints())
    for (const tool of ROUTE_TOOLS)
      assert.deepEqual(
        resolveDraftRoute(endpoint, tool),
        resolveRoute(
          { ...endpoint, anthropicBaseUrl: endpoint.anthropicBaseUrl || null },
          tool,
        ),
        JSON.stringify({ tool, endpoint }),
      );
});

test("capability fields mirror the library defaults and choices", () => {
  for (const source of SOURCES) {
    const fields = CAPABILITY_FIELDS[source];
    assert.deepEqual(
      Object.fromEntries(fields.map((f) => [f.name, f.default])),
      { ...CAPABILITY_DEFAULTS[libraryProtocol(source)] },
      source,
    );
  }
  const chat = Object.fromEntries(
    CAPABILITY_FIELDS.chatCompletions.map((f) => [f.name, f]),
  );
  assert.deepEqual(chat.systemMessages.choices, ["merge", "inline"]);
  assert.deepEqual(chat.maxTokensField.choices, ["max_tokens", "max_completion_tokens"]);
});

test("route options explain why a choice is unavailable (Review Focus 2)", () => {
  const chatOnly = {
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: "",
    protocols: { messages: true, responses: false, chatCompletions: true },
    routing: { claude: "adapter:responses", codex: "auto", opencode: "auto" },
  };
  const options = Object.fromEntries(
    routeOptions(chatOnly, "claude").map((o) => [o.choice, o]),
  );
  assert.deepEqual(options.native, {
    choice: "native",
    source: "messages",
    available: false,
    reason: "anthropicUrlMissing",
  });
  assert.equal(options["adapter:responses"].reason, "protocolOff");
  assert.equal(options["adapter:chatCompletions"].available, true);
  assert.equal(options.auto.available, true);
  assert.equal(options.off.available, true);
  assert.equal(resolveDraftRoute(chatOnly, "claude"), null);
  assert.deepEqual(adapterSources(chatOnly), ["chatCompletions"]);
});

test("a missing OpenAI base URL is reported apart from a disabled protocol", () => {
  const noOpenaiUrl = {
    openaiBaseUrl: " ",
    anthropicBaseUrl: "https://llm.example",
    protocols: { messages: false, responses: true, chatCompletions: false },
    routing: { claude: "auto", codex: "auto", opencode: "auto" },
  };
  const reasons = Object.fromEntries(
    routeOptions(noOpenaiUrl, "codex").map((o) => [o.choice, o.reason]),
  );
  assert.equal(reasons.native, "openaiUrlMissing");
  assert.equal(reasons["adapter:chatCompletions"], "openaiUrlMissing");
  assert.equal(reasons["adapter:messages"], "protocolOff");
});
