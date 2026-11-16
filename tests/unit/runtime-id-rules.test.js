import test from "node:test";
import assert from "node:assert/strict";
import {
  productSources,
  runtimeIdLiterals,
  runtimeNamedFiles,
  webRuntimeImporters,
} from "../helpers/runtime-id-scan.js";

// ADR 0007 (runtime descriptor): outside the runtime modules no product code names a
// runtime. What a runtime does differently is a trait its descriptor states
// (server runtimes/runtime-traits.js), read through traitOf; what only one runtime
// has lives in its own module.

const sources = await productSources();
const hint =
  "read the runtime's trait (traitOf) or move the code into the runtime's module; " +
  "never add to this list";

// The files that still name a runtime id, with how often. This list may only shrink:
// each group names the step of the runtime descriptor work that empties it.
// (One exception, once: when the scanner learned to count unquoted object keys
// (`hermes: …`), the keys that already existed were entered under the step that
// removes them. Those of advanced-config.js went with step 4, the two of
// agent-browsers.js with the readers of step 5.)
const runtimeIdAllowlist = {
  // Permanent: "openclaw" as something other than an agent's runtime.
  // The holder of a login (model-accounts.js: "agentpier" or "openclaw").
  "server/features/assistants/model-accounts.js": 6,
  "server/features/assistants/model-account-move.js": 1,
  "server/features/mcp-servers/mcp-oauth-holders.js": 1,
  "web/features/assistants/ChatgptAccountDetail.jsx": 1,
  "web/features/mcp-servers/McpOAuthLogin.jsx": 1,
  "web/features/mcp-servers/McpOAuthStatus.jsx": 1,
  // The consumer of AgentPier's MCP proxy (proxy-access.js).
  "server/application/assistant-graph.js": 1,
  "server/features/assistants/mcp-changes.js": 1,
  "server/features/assistants/proxy-access.js": 1,
  // The source of an allowlist entry, and the name of OpenClaw's temporary folder.
  "server/features/assistants/exec-allowlist.js": 1,
  "server/features/assistants/browser-upload-staging.js": 1,
};

// No file outside the runtime modules is named after a runtime: Hermes's services,
// wiring, routes and backup paths and OpenClaw's MCP command line live in their
// adapters since step 5.
const runtimeNamedFileAllowlist = [];

test("runtime rule idLiterals: no product code outside the runtime modules names a runtime", () => {
  assert.deepEqual(runtimeIdLiterals(sources), sortedByKey(runtimeIdAllowlist), hint);
});

test("runtime rule namedFiles: no file outside the runtime modules is named after a runtime", () => {
  assert.deepEqual(
    runtimeNamedFiles(sources),
    [...runtimeNamedFileAllowlist].sort(),
    hint,
  );
});

test("the files the trait, runtime list, surface, settings and reader steps moved name no runtime", () => {
  for (const file of [
    "server/features/assistants/advanced-config.js",
    "server/http/routes/assistant-advanced-settings.js",
    "web/features/assistants/hub/RuntimeAdvancedGroup.jsx",
    "web/features/assistants/hub/RuntimeOwnSettings.jsx",
    "web/features/assistants/hub/runtime-draft.js",
    "web/features/assistants/hub/advanced-scopes.js",
    "web/features/settings/AdvancedSettingRow.jsx",
    "web/features/assistants/runtime-capabilities.js",
    "web/features/assistants/wizard/AgentWizard.jsx",
    "web/features/assistants/wizard/StepStart.jsx",
    "web/features/assistants/wizard/StepReview.jsx",
    "web/features/assistants/useRuntimes.js",
    "web/features/assistants/RuntimeSlot.jsx",
    "web/features/assistants/runtime-surfaces.js",
    "web/features/assistants/runtime-surface-search.js",
    "web/features/assistants/hub/RuntimeTab.jsx",
    "web/features/assistants/hub-routes.js",
    "web/app/search-entries.js",
    "web/features/assistants/shell-level.js",
    "web/features/assistants/TelegramSendersSettings.jsx",
    "web/features/assistants/settings/CapabilityGroups.jsx",
    "web/features/assistants/wizard/wizard-draft.js",
    "web/features/assistants/wizard/wizard-creation.js",
    "web/features/assistants/wizard/StepCapabilities.jsx",
    "server/features/assistants/chat-file-folders.js",
    "server/features/assistants/own-process-agents.js",
    "server/features/assistants/memory-archive.js",
    "server/features/assistants/memory-entries.js",
    "server/features/assistants/memory-review-answer.js",
    "server/features/assistants/memory-review-prompt.js",
    "server/features/assistants/memory-review.js",
    "server/features/assistants/native-memory.js",
    "server/features/assistants/assistant-bootstrap.js",
    "server/features/assistants/own-process-guidance.js",
    "server/features/assistants/assistant-maintenance.js",
    "server/features/assistants/agent-browsers.js",
    "server/application/assistants.js",
  ]) {
    assert.ok(
      sources.some((source) => source.file === file),
      `${file} is scanned`,
    );
    assert.equal(Object.hasOwn(runtimeIdAllowlist, file), false, file);
  }
});

// Step 3 of ADR 0007: a runtime's own UI lives in its web module and reaches a page
// through a slot. Only the slot and the search index ask the web runtime modules.
test("runtime rule webImports: only the slot and the search index import a web runtime module", () => {
  assert.deepEqual(webRuntimeImporters(sources), [
    "web/features/assistants/RuntimeSlot.jsx",
    "web/features/assistants/runtime-surface-search.js",
  ]);
  assert.deepEqual(
    webRuntimeImporters([
      { file: "web/a.jsx", text: 'import x from "./assistants/runtimes/index.js";' },
      { file: "web/b.js", text: 'const y = await import("../runtimes/hermes/x.js");' },
      { file: "web/c.js", text: 'import z from "./runtimes-list.js"; // runtimes/' },
      { file: "server/d.js", text: 'import d from "./runtimes/runtime-for.js";' },
    ]),
    ["web/a.jsx", "web/b.js"],
  );
});

function sortedByKey(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)));
}

test("the id scanner finds literals, not prefixes or prose", () => {
  const found = runtimeIdLiterals([
    { file: "a.js", text: "if (x === \"hermes\") y(`openclaw`); z('hermes');" },
    { file: "b.js", text: 'id.startsWith("openclaw:"); name = "Hermes Agent";' },
    { file: "c.js", text: 'import x from "./hermes-runtime.js"; const hermes = 1;' },
  ]);
  assert.deepEqual(found, { "a.js": 3 });
});

test("the id scanner counts unquoted object keys, not ternaries, strings or paths", () => {
  const found = runtimeIdLiterals([
    { file: "keys.js", text: "const names = {\n  openclaw: 1,\n  hermes: 2,\n};" },
    {
      file: "inline.js",
      text: "f({ hermes: state, other: 1 }); const { openclaw: o } = x;",
    },
    { file: "both.js", text: 'const t = { hermes: "hermes" };' },
    // A ternary's branch, a shorthand property and a member are no keys.
    {
      file: "ternary.js",
      text: "const r = on ? hermes : openclaw; g({ hermes }, x.hermes);",
    },
    // Session keys, prefixes and routes inside strings and patterns.
    {
      file: "strings.js",
      text: 'a("agent:x:hermes:cron"); b(/^agent:[^:]+:hermes:/); c("/runtime/hermes:x"); d(/^openclaw:/);',
    },
    {
      file: "words.js",
      text: "const view = { myhermes: 1, hermesState: 2, hermes_x: 3 };",
    },
  ]);
  assert.deepEqual(found, { "keys.js": 2, "inline.js": 2, "both.js": 2 });
});

test("the file scanner finds runtime-named files", () => {
  assert.deepEqual(
    runtimeNamedFiles([
      { file: "web/features/assistants/hermes-runtime.js", text: "" },
      { file: "server/features/assistants/openclaw-x.js", text: "" },
      { file: "web/features/assistants/useHermesRuntime.js", text: "" },
      { file: "server/features/assistants/memory.js", text: "" },
    ]),
    [
      "server/features/assistants/openclaw-x.js",
      "web/features/assistants/hermes-runtime.js",
    ],
  );
});

test("the product sources leave out the runtime modules and the catalogs", async () => {
  const files = (await productSources()).map(({ file }) => file);
  assert.ok(files.includes("server/features/assistants/chat-file-folders.js"));
  assert.ok(files.includes("web/features/assistants/shell-level.js"));
  assert.ok(files.includes("web/features/assistants/wizard/AgentWizard.jsx"));
  for (const prefix of [
    "server/features/assistants/runtimes/",
    "web/features/assistants/runtimes/",
    "server/lib/i18n/",
    "web/lib/i18n/",
  ])
    assert.equal(
      files.some((file) => file.startsWith(prefix)),
      false,
      prefix,
    );
});
