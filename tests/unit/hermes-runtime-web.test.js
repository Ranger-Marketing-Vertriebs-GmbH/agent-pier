import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesBusy,
  hermesErrorText,
  hermesStatus,
  validHermes,
} from "../../web/features/assistants/runtimes/hermes/install-state.js";
import { updateCauseDetail } from "../../web/features/assistants/update-cause.js";
import {
  offersEveryCommand,
  shellChoice,
  shellFields,
} from "../../web/features/assistants/shell-level.js";
import {
  modelsFor,
  runtimeName,
  surfaceCapabilities,
} from "../../web/features/assistants/runtime-capabilities.js";
import {
  capabilityPatch,
  capabilityServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import {
  duplicateFields,
  emptyDraft,
  withRuntime,
} from "../../web/features/assistants/wizard/wizard-draft.js";
import { createBody } from "../../web/features/assistants/wizard/wizard-creation.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

// AGENTPIER-332: Hermes Agent as a second runtime in the web app.
const hermesInfo = {
  id: "hermes",
  name: "Hermes Agent",
  version: "0.22.5",
  capabilities: {
    approvals: {
      available: true,
      shellLevels: ["off", "approval", "every", "full"],
      allowlist: "exactCommands",
    },
    models: { available: true, chatgptLogin: "agentpierHeld" },
  },
};
const openClawInfo = {
  id: "openclaw",
  name: "OpenClaw",
  capabilities: {
    approvals: {
      available: true,
      shellLevels: ["off", "approval", "full"],
      allowlist: "patterns",
    },
    models: { available: true, chatgptLogin: "any" },
  },
};
const agent = (extra = {}) => ({
  id: "a",
  name: "A",
  revision: 1,
  capabilities: { memory: false, reminders: false },
  ...extra,
});

test("the Hermes state row follows install, update, error and switch", () => {
  const state = (extra) => ({ enabled: true, installed: true, ...extra });
  assert.deepEqual(hermesStatus(state({ installing: true, error: "X" })), {
    kind: "installing",
    tone: "pending",
  });
  assert.equal(hermesStatus(state({ updating: true })).kind, "updating");
  assert.deepEqual(hermesStatus(state({ error: "HERMES_UPDATE_FAILED" })), {
    kind: "error",
    tone: "error",
  });
  assert.deepEqual(hermesStatus(state({ enabled: false })), {
    kind: "off",
    tone: "idle",
  });
  assert.deepEqual(hermesStatus(state()), { kind: "ready", tone: "ok" });
  assert.equal(hermesStatus(state({ installed: false })).kind, "notInstalled");
  assert.equal(hermesStatus(null).kind, "off");
  // The group's state is the install state of the runtime list entry it is handed.
  const install = { kind: "optional", ...state() };
  assert.equal(validHermes(install), install);
  // An entry without an install state of the owner's switch: no state, no group.
  assert.equal(validHermes({ kind: "builtin" }), null);
  assert.equal(validHermes(undefined), null);
  assert.equal(hermesBusy(state({ updating: true })), true);
  assert.equal(hermesBusy(state()), false);
  assert.equal(validHermes({ enabled: "yes" }), null);
  assert.equal(validHermes(null), null);
  const errors = { KNOWN: "known" };
  const fallback = (code) => `other ${code}`;
  assert.equal(hermesErrorText("KNOWN", errors, fallback), "known");
  assert.equal(hermesErrorText("toString", errors, fallback), "other toString");
});

test("a staging failure's cause shows its code and the upstream HTTP status", () => {
  assert.equal(
    updateCauseDetail({ code: "ECONNRESET", upstreamStatus: null }),
    "ECONNRESET",
  );
  assert.equal(updateCauseDetail({ code: null, upstreamStatus: 429 }), "HTTP 429");
  assert.equal(
    updateCauseDetail({ code: "DOWNLOAD_IDLE_TIMEOUT", upstreamStatus: 504 }),
    "DOWNLOAD_IDLE_TIMEOUT · HTTP 504",
  );
  for (const cause of [null, "ENOSPC", {}, { code: "<b>x</b>", upstreamStatus: "429" }])
    assert.equal(updateCauseDetail(cause), "");
});

test("only a runtime offering it asks before every command", () => {
  assert.equal(offersEveryCommand(hermesInfo), true);
  assert.equal(offersEveryCommand(openClawInfo), false);
  assert.equal(offersEveryCommand(undefined), false);
  const every = { shell: "approval", shellEveryCommand: true };
  assert.equal(shellChoice(agent({ ...every, runtimeInfo: hermesInfo })), "every");
  assert.equal(shellChoice(agent({ ...every, runtimeInfo: openClawInfo })), "approval");
  assert.equal(
    shellChoice(agent({ shell: "approval", runtimeInfo: hermesInfo })),
    "approval",
  );
  assert.equal(
    shellChoice(
      agent({ shell: "full", shellEveryCommand: true, runtimeInfo: hermesInfo }),
    ),
    "full",
  );
  assert.deepEqual(shellFields("every", true), {
    shell: "approval",
    shellEveryCommand: true,
  });
  assert.deepEqual(shellFields("full", true), {
    shell: "full",
    shellEveryCommand: false,
  });
  assert.deepEqual(shellFields("approval", false), { shell: "approval" });
  assert.deepEqual(shellFields("every", false), { shell: "approval" });
});

test("a Hermes agent's shell choice saves shellEveryCommand; OpenClaw's never", () => {
  const hermes = agent({ runtimeInfo: hermesInfo, shell: "off" });
  const base = capabilityServer(hermes);
  assert.equal(base.shell, "off");
  assert.deepEqual(
    capabilityPatch({ values: { ...base, shell: "every" }, base, assistant: hermes }),
    {
      shell: "approval",
      shellEveryCommand: true,
    },
  );
  const strict = agent({
    runtimeInfo: hermesInfo,
    shell: "approval",
    shellEveryCommand: true,
  });
  const strictBase = capabilityServer(strict);
  assert.equal(strictBase.shell, "every");
  assert.deepEqual(
    capabilityPatch({
      values: { ...strictBase, shell: "approval" },
      base: strictBase,
      assistant: strict,
    }),
    { shell: "approval", shellEveryCommand: false },
  );
  const openClaw = agent({ runtimeInfo: openClawInfo, shell: "off" });
  const openBase = capabilityServer(openClaw);
  assert.deepEqual(
    capabilityPatch({
      values: { ...openBase, shell: "approval" },
      base: openBase,
      assistant: openClaw,
    }),
    { shell: "approval" },
  );
});

test("the wizard keeps a runtime per draft and sends Hermes' shell choice", () => {
  const draft = { ...emptyDraft(), name: "N", connectionId: "c", modelId: "m" };
  assert.deepEqual(withRuntime(draft, "hermes", [], hermesInfo), { runtime: "hermes" });
  // A runtime without "Every command" among its shell levels falls back.
  assert.deepEqual(withRuntime({ ...draft, shell: "every" }, "", [], openClawInfo), {
    runtime: "",
    shell: "approval",
  });
  assert.deepEqual(withRuntime({ ...draft, shell: "every" }, "hermes", [], hermesInfo), {
    runtime: "hermes",
  });
  // While the runtime's traits are unknown (the list did not arrive), nothing the
  // owner chose is taken back.
  assert.deepEqual(withRuntime({ ...draft, shell: "every" }, "hermes", [], undefined), {
    runtime: "hermes",
  });
  // The default runtime's shell levels are the defaults, known without the list:
  // leaving a duplicate of a Hermes agent never keeps "every" on it.
  assert.deepEqual(withRuntime({ ...draft, shell: "every" }, "", [], undefined), {
    runtime: "",
    shell: "approval",
  });
  // The draft alone says whether every command asks: "every" is only ever chosen
  // where the runtime offers it, and the server refuses it elsewhere.
  const hermes = { ...draft, runtime: "hermes", shell: "every" };
  assert.equal(createBody(hermes).runtime, "hermes");
  assert.equal(createBody(hermes).shell, "approval");
  assert.equal(createBody(hermes).shellEveryCommand, true);
  assert.deepEqual(
    [
      createBody({ ...hermes, shell: "off" }).shell,
      "shellEveryCommand" in createBody({ ...hermes, shell: "off" }),
    ],
    ["off", false],
  );
  assert.equal("shellEveryCommand" in createBody({ ...draft, shell: "approval" }), false);
  // A duplicate of a Hermes agent keeps its runtime and its strict level.
  const source = agent({
    runtime: "hermes",
    runtimeInfo: hermesInfo,
    shell: "approval",
    shellEveryCommand: true,
  });
  const copy = duplicateFields(source, null, null, (name) => `Copy of ${name}`);
  assert.equal(copy.runtime, "hermes");
  assert.equal(copy.shell, "every");
  // An agent view names its runtime itself; one without a view falls back to the
  // default runtime of the list, then to neutral words, never to a product name.
  assert.equal(runtimeName(source), "Hermes Agent");
  assert.equal(runtimeName(agent(), [openClawInfo, hermesInfo]), "OpenClaw");
  setLanguage("en", { persist: false });
  assert.equal(runtimeName(agent()), "The agent's runtime");
  assert.equal(runtimeName(undefined, []), "The agent's runtime");
  setLanguage("de", { persist: false });
});

test("a Hermes agent lists ChatGPT logins OpenClaw holds unavailable and drops a chosen one", () => {
  const held = {
    id: "openclaw:b",
    providerId: "openai-chatgpt",
    holder: "agentpier",
    available: true,
  };
  const models = [
    { id: "openclaw:a", providerId: "openai-chatgpt", available: true },
    { id: "c", providerId: "endpoint", available: true },
    held,
  ];
  assert.equal(modelsFor(models, openClawInfo), models);
  // A runtime whose traits are unknown lists every login as it is.
  assert.equal(modelsFor(models, undefined), models);
  assert.deepEqual(modelsFor(models, hermesInfo), [
    { ...models[0], available: false, reason: "runtimeAccount" },
    models[1],
    held,
  ]);
  // A login AgentPier holds stays chosen.
  assert.deepEqual(
    withRuntime(
      { ...emptyDraft(), connectionId: "openclaw:b", modelId: "gpt-5" },
      "hermes",
      models,
      hermesInfo,
    ),
    { runtime: "hermes" },
  );
  const draft = { ...emptyDraft(), connectionId: "openclaw:a", modelId: "gpt-5" };
  assert.deepEqual(withRuntime(draft, "hermes", models, hermesInfo), {
    runtime: "hermes",
    connectionId: "",
    modelId: "",
  });
  assert.deepEqual(withRuntime(draft, "", models, openClawInfo), { runtime: "" });
  // Unknown traits clear nothing.
  assert.deepEqual(withRuntime(draft, "hermes", models, undefined), {
    runtime: "hermes",
  });
});

test("an agent's own Telegram bot needs the runtime's channelBots capability", () => {
  assert.equal(surfaceCapabilities.channels, "channels");
  assert.equal(surfaceCapabilities.telegramSenders, "channelBots");
});
