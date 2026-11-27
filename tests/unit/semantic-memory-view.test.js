import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  semanticMemoryView,
  switchRefusal,
  validSemanticMemory,
} from "../../web/features/assistants/hub/semantic-memory-view.js";
import { agentsRuntimeSections } from "../../web/features/assistants/hub-routes.js";
import { liveTopics } from "../../web/lib/live/live-topics.js";
import * as de from "../../web/lib/i18n/de/assistant-semantic-memory.js";
import * as en from "../../web/lib/i18n/en/assistant-semantic-memory.js";

// What Agents › Runtime › Semantic memory search shows of each state the server
// reports (semantic-memory-view.js), in English.
setLanguage("en");
const bytes = (value) => `${Math.round(value / 2 ** 20)} MB`;
const status = (patch = {}) => ({
  available: true,
  enabled: false,
  state: "off",
  progress: null,
  failure: null,
  pending: false,
  revision: 1,
  model: { id: "m", size: 328577056, termsUrl: "https://ai.google.dev/gemma/terms" },
  ...patch,
});
const view = (patch) => semanticMemoryView(status(patch), bytes);

test("off offers the switch on and says what it does", () => {
  assert.deepEqual(view(), {
    tone: "idle",
    state: "Off",
    running: false,
    progress: "",
    note: "",
    alert: "",
    action: {
      kind: "on",
      label: "Turn on …",
      hint: "Downloads the model, restarts the agent service and rebuilds the indexes.",
      disabled: false,
    },
  });
});

test("on offers the switch off; a rebuild still waiting for a start is said", () => {
  const on = view({ enabled: true, state: "on" });
  assert.equal(on.tone, "ok");
  assert.equal(on.state, "On");
  assert.deepEqual(on.action, {
    kind: "off",
    label: "Turn off …",
    hint: "Restarts the agent service and goes back to keyword search.",
    disabled: false,
  });
  assert.equal(on.note, "");
  assert.equal(
    view({ enabled: true, state: "on", pending: true }).note,
    "On. The memory indexes are rebuilt when the agent service starts.",
  );
});

test("a running switch shows its step and locks the switch", () => {
  const downloading = view({
    state: "downloading",
    progress: { received: 100 * 2 ** 20, total: 313 * 2 ** 20 },
  });
  assert.equal(downloading.tone, "working");
  assert.equal(downloading.state, "Downloading");
  assert.equal(downloading.running, true);
  assert.equal(downloading.progress, "Downloading the embedding model: 100 MB of 313 MB");
  assert.equal(downloading.action.disabled, true);
  const step = (progress, enabled = true) =>
    view({ enabled, state: "rebuilding", progress }).progress;
  assert.equal(
    step({ phase: "stopping", target: "local" }),
    "Stopping the agent service",
  );
  assert.equal(
    step({ phase: "indexing", target: "local", done: 2, total: 5 }),
    "Rebuilding the memory indexes: 2 of 5 agents",
  );
  assert.equal(
    step({ phase: "indexing", done: 0, total: 0 }),
    "Rebuilding the memory indexes",
  );
  assert.equal(step({ phase: "starting" }), "Starting the agent service");
  // A phase a newer server names reads as the rebuild.
  assert.equal(step({ phase: "verifying" }), "Rebuilding the memory indexes");
  const rebuilding = view({
    enabled: false,
    state: "rebuilding",
    progress: { phase: "indexing" },
  });
  assert.equal(rebuilding.state, "Rebuilding");
  assert.equal(rebuilding.action.disabled, true);
});

test("a failure reads as off with its reason and can be tried again", () => {
  const failed = view({
    state: "failed",
    failure: { code: "MEMORY_INDEX_FAILED", at: 1 },
  });
  assert.equal(failed.tone, "error");
  assert.equal(failed.state, "Off");
  assert.equal(
    failed.alert,
    "The memory indexes could not be rebuilt with the embedding model. Keyword search was restored.",
  );
  assert.equal(failed.action.kind, "on");
  assert.equal(failed.action.disabled, false);
  // Every failure the server can record has its own words in both languages.
  const codes = [
    "INTERRUPTED",
    "SERVICE_BUSY",
    "EMBEDDING_DOWNLOAD_FAILED",
    "EMBEDDING_DOWNLOAD_STALLED",
    "EMBEDDING_CHECKSUM_MISMATCH",
    "EMBEDDING_DISK_SPACE",
    "EMBEDDING_SERVER_UNUSABLE",
    "EMBEDDING_MODEL_MISSING",
    "EMBEDDING_SERVER_MISSING",
    "RUNTIME_UPDATE_REQUIRED",
    "MEMORY_INDEX_FAILED",
    "MEMORY_INDEX_TIMEOUT",
    "MEMORY_INDEX_UNVERIFIED",
  ];
  for (const catalog of [de, en])
    assert.deepEqual(
      Object.keys(catalog.assistantSemanticMemoryCopy.failures).sort(),
      [...codes].sort(),
    );
  // A code this build does not know is still shown, never hidden.
  assert.equal(
    view({ state: "failed", failure: { code: "ENABLE_FAILED" } }).alert,
    "It could not be switched (ENABLE_FAILED). Memory search works by keyword.",
  );
});

test("where it cannot run the switch on is locked with the reason; off stays possible", () => {
  for (const [reason, text] of [
    [
      "EMBEDDING_PLATFORM_UNSUPPORTED",
      "Not available on this computer: there is no llama.cpp build for its platform.",
    ],
    [
      "RUNTIME_UPDATE_REQUIRED",
      "Needs the current OpenClaw runtime. Activate the update under OpenClaw updates first.",
    ],
    ["SERVICE_STOPPED", "Start the agent service first."],
  ]) {
    const blocked = view({ available: false, reason });
    assert.equal(blocked.action.disabled, true, reason);
    assert.equal(blocked.action.hint, text);
    // Already on (the service stopped meanwhile): switching off is never locked.
    const on = view({ available: false, reason, enabled: true, state: "on" });
    assert.equal(on.action.kind, "off");
    assert.equal(on.action.disabled, false);
  }
});

test("a refused switch is told in words", () => {
  const text = (code) => switchRefusal({ code, message: code });
  assert.equal(
    text("SEMANTIC_MEMORY_CONFLICT"),
    "This changed in the meantime. The current state is shown.",
  );
  assert.equal(
    text("SEMANTIC_MEMORY_OPERATION_RUNNING"),
    "A switch is already in progress.",
  );
  assert.equal(text("SEMANTIC_MEMORY_SERVICE_STOPPED"), "Start the agent service first.");
  assert.equal(
    text("SEMANTIC_MEMORY_TERMS_REQUIRED"),
    "It could not be switched (TERMS_REQUIRED). Memory search works by keyword.",
  );
  assert.equal(switchRefusal(new Error("Request failed (503)")), "Request failed (503)");
});

test("only a status this build understands is shown", () => {
  assert.equal(validSemanticMemory(status()), true);
  for (const broken of [
    null,
    {},
    status({ state: "verifying" }),
    status({ revision: "1" }),
  ])
    assert.equal(validSemanticMemory(broken), false);
});

test("the group has its live topic, its route and its place on the Runtime tab", () => {
  const topic = liveTopics["runtime.semantic-memory"];
  assert.equal(topic.mode, "state");
  assert.equal(topic.path(), "/assistant-semantic-memory");
  // Pushed by the service: not a sampled topic a hidden tab would drop.
  assert.equal(topic.sampled, undefined);
  assert.ok(agentsRuntimeSections.includes("memory-search"));
});
