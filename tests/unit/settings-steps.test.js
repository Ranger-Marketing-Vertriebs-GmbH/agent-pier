import test from "node:test";
import assert from "node:assert/strict";
import { completedLabels, runSaveChain } from "../../web/lib/settings/save-chain.js";
import { markSaved } from "../../web/lib/settings/draft-state.js";
import {
  capacityInvalid,
  featureStep,
  fieldCheckStep,
  hostCapacityStep,
  languageStep,
  preferencesStep,
  updateChannelStep,
} from "../../web/features/settings/settings-steps.js";

const base = {
  language: "de",
  defaultCwd: "/home/a",
  autoResumeInterrupted: true,
  agentsEnabled: false,
};
function workspace(calls, { failFeature = false, failRefresh = false } = {}) {
  return [
    languageStep({
      label: "Sprache",
      apply: (language) => calls.push(["language", language]),
    }),
    preferencesStep({
      label: "Allgemein",
      save: async (body) => {
        calls.push(["preferences", body]);
        return body;
      },
      refresh: async () => {
        calls.push(["refresh"]);
        if (failRefresh) throw new Error("offline");
      },
    }),
    featureStep({
      label: "Agenten",
      setEnabled: async (enabled) => {
        calls.push(["feature", enabled]);
        if (failFeature)
          throw Object.assign(new Error("Feature failed"), { status: 500 });
      },
    }),
  ];
}

test("the workspace saves language first and sends only changed preferences", async () => {
  const calls = [];
  const values = {
    ...base,
    language: "en",
    autoResumeInterrupted: false,
    agentsEnabled: true,
  };
  const result = await runSaveChain({ steps: workspace(calls), values, base });
  assert.equal(result.status, "saved");
  assert.deepEqual(calls, [
    ["language", "en"],
    ["preferences", { autoResumeInterrupted: false }],
    ["refresh"],
    ["feature", true],
  ]);
});

test("a changed MCP directory key sends the whole directory setting", async () => {
  const directory = {
    ...base,
    mcpDirectoryEnabled: true,
    mcpDirectoryBaseUrl: "https://registry.modelcontextprotocol.io",
  };
  const calls = [];
  const result = await runSaveChain({
    steps: workspace(calls),
    values: { ...directory, mcpDirectoryBaseUrl: "  https://mirror.example.test/ " },
    base: directory,
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(calls, [
    [
      "preferences",
      { mcpDirectory: { enabled: true, baseUrl: "https://mirror.example.test/" } },
    ],
    ["refresh"],
  ]);
  const untouched = [];
  await runSaveChain({
    steps: workspace(untouched),
    values: { ...directory, autoResumeInterrupted: false },
    base: directory,
  });
  assert.deepEqual(untouched[0], ["preferences", { autoResumeInterrupted: false }]);
});

test("unchanged steps are skipped and a failed refresh does not fail the save", async () => {
  const calls = [];
  const values = { ...base, defaultCwd: "~/work" };
  const result = await runSaveChain({
    steps: workspace(calls, { failRefresh: true }),
    values,
    base,
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(calls, [["preferences", { defaultCwd: "~/work" }], ["refresh"]]);
});

test("a failed feature step reports what was saved and a retry skips it", async () => {
  const calls = [];
  const steps = workspace(calls, { failFeature: true });
  const values = { ...base, autoResumeInterrupted: false, agentsEnabled: true };
  const first = await runSaveChain({ steps, values, base });
  assert.equal(first.status, "error");
  assert.equal(first.failedStep, "feature");
  assert.deepEqual(completedLabels(steps, first), ["Allgemein"]);
  const retryBase = markSaved(base, values, first.savedKeys);
  calls.length = 0;
  await runSaveChain({ steps, values, base: retryBase });
  assert.deepEqual(calls, [["feature", true]]);
});

test("host capacity sends the draft revision and passes on the new one", async () => {
  const bodies = [];
  const step = hostCapacityStep({
    label: "Team",
    save: async (body) => {
      bodies.push(body);
      return { revision: 8, hostMaxConcurrent: body.hostMaxConcurrent };
    },
  });
  const result = await runSaveChain({
    steps: [step],
    values: { hostMaxConcurrent: 16 },
    base: { hostMaxConcurrent: 12 },
    revisions: { team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies, [{ revision: 7, hostMaxConcurrent: 16 }]);
  assert.equal(result.revisions.team, 8);
});

test("a stale revision is a conflict but a capacity refusal is an error", async () => {
  const refuse = (messageKey) =>
    hostCapacityStep({
      label: "Team",
      save: async () => {
        throw Object.assign(new Error("refused"), { status: 409, messageKey });
      },
    });
  const run = (step) =>
    runSaveChain({
      steps: [step],
      values: { hostMaxConcurrent: 4 },
      base: { hostMaxConcurrent: 8 },
      revisions: { team: 1 },
    });
  assert.equal((await run(refuse("assistants.conflict"))).status, "conflict");
  assert.equal((await run(refuse("assistants.hostCapacity"))).status, "error");
});

test("the update channel step reports the saved releases", async () => {
  const seen = [];
  const step = updateChannelStep({
    label: "Updatekanal",
    save: async (channel) => ({ updateChannel: channel }),
    onSaved: (result) => seen.push(result),
  });
  const result = await runSaveChain({
    steps: [step],
    values: { updateChannel: "preview" },
    base: { updateChannel: "stable" },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(seen, [{ updateChannel: "preview" }]);
});

test("a field check stops the chain before any request and saves nothing", async () => {
  const calls = [];
  const steps = [
    fieldCheckStep({
      id: "directory",
      fields: ["defaultCwd"],
      error: (values) => (values.defaultCwd.trim() ? "" : "Directory required"),
    }),
    ...workspace(calls),
  ];
  const values = { ...base, language: "en", defaultCwd: " " };
  const result = await runSaveChain({ steps, values, base });
  assert.equal(result.status, "error");
  assert.equal(result.error.message, "Directory required");
  assert.deepEqual(calls, []);
  assert.deepEqual(completedLabels(steps, result), []);
  assert.deepEqual(result.savedKeys, []);
  // An unchanged field is never checked.
  const other = await runSaveChain({
    steps,
    values: { ...base, defaultCwd: "", autoResumeInterrupted: false },
    base: { ...base, defaultCwd: "" },
  });
  assert.equal(other.status, "saved");
});

test("the host capacity keeps the old 4 to 32 range", () => {
  for (const value of ["", 2, 3, 33, 4.5, null])
    assert.equal(capacityInvalid(value), true);
  for (const value of [4, 16, 32]) assert.equal(capacityInvalid(value), false);
});

test("an agent switch the server did not apply fails the step", async () => {
  const step = featureStep({
    label: "Agenten",
    setEnabled: async () => ({ enabled: false, error: "ASSISTANT_STORAGE_UNSAFE" }),
    notApplied: (feature) => `not applied: ${feature.error}`,
  });
  const result = await runSaveChain({
    steps: [step],
    values: { agentsEnabled: true },
    base: { agentsEnabled: false },
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.message, "not applied: ASSISTANT_STORAGE_UNSAFE");
  assert.deepEqual(result.savedKeys, []);
});

test("step labels are read after the language step switched the language", async () => {
  let language = "de";
  const steps = [
    languageStep({
      label: () => (language === "de" ? "Sprache" : "Language"),
      apply: (next) => {
        language = next;
      },
    }),
    preferencesStep({
      label: "General",
      save: async () => {
        throw new Error("offline");
      },
    }),
  ];
  const result = await runSaveChain({
    steps,
    values: { ...base, language: "en", autoResumeInterrupted: false },
    base,
  });
  assert.equal(result.status, "error");
  assert.deepEqual(completedLabels(steps, result), ["Language"]);
});

test("the update channel refuses while a release job runs", async () => {
  const sent = [];
  let busy = true;
  const step = updateChannelStep({
    label: "Updatekanal",
    save: async (channel) => sent.push(channel),
    blocked: () => (busy ? "Job running" : ""),
  });
  const run = () =>
    runSaveChain({
      steps: [step],
      values: { updateChannel: "preview" },
      base: { updateChannel: "stable" },
    });
  const refused = await run();
  assert.equal(refused.status, "error");
  assert.equal(refused.error.message, "Job running");
  assert.deepEqual(sent, []);
  busy = false;
  assert.equal((await run()).status, "saved");
  assert.deepEqual(sent, ["preview"]);
});
