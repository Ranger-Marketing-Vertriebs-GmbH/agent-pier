import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  capabilityServer,
  heartbeatKeys,
  routinesServer,
  telegramServer,
  workServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import {
  capabilityStep,
  channelStep,
  createStep,
  heartbeatStep,
  memoryStep,
  workStep,
} from "../../web/features/assistants/settings/agent-settings-steps.js";

const assistant = {
  id: "home",
  revision: 2,
  capabilities: { memory: true },
  heartbeat: { enabled: false, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
};

test("the Capabilities save is one PATCH with the base revision and confirmations", async () => {
  const bodies = [];
  const update = async (id, body) => {
    bodies.push([id, body]);
    if (!body.confirmShell)
      throw Object.assign(new Error("confirm"), {
        code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
        required: ["confirmShell"],
      });
    return { revision: 3 };
  };
  const base = capabilityServer(assistant);
  const result = await runSaveChain({
    steps: [capabilityStep({ assistant, label: "Capabilities", update })],
    values: { ...base, shell: "approval" },
    base,
    revisions: { assistant: 2 },
    ask: async (request) => request.kind === "shell",
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies, [
    ["home", { shell: "approval", revision: 2 }],
    ["home", { shell: "approval", revision: 2, confirmShell: true }],
  ]);
  assert.equal(result.revisions.assistant, 3);
});

test("a Telegram save that fails at the channel keeps the heartbeat as saved", async () => {
  const calls = [];
  const steps = [
    heartbeatStep({
      assistant,
      label: "Acting on its own",
      update: async (id, body) => {
        calls.push(["assistant", body]);
        return { revision: 3 };
      },
    }),
    channelStep({
      channelId: "c1",
      label: "Connection",
      updateChannel: async (id, body) => {
        calls.push(["channel", id, body]);
        throw Object.assign(new Error("down"), { status: 500 });
      },
    }),
  ];
  const base = {
    ...routinesServer(assistant),
    ...telegramServer({ language: "de", appUrl: "", revision: 5 }),
  };
  const values = { ...base, heartbeatEnabled: true, language: "en" };
  const result = await runSaveChain({
    steps,
    values,
    base,
    revisions: { assistant: 2, channel: 5 },
  });
  assert.equal(result.status, "error");
  assert.deepEqual(result.completed, ["assistant"]);
  assert.deepEqual(result.savedKeys, heartbeatKeys);
  assert.deepEqual(calls, [
    [
      "assistant",
      {
        heartbeat: {
          enabled: true,
          interval: "4h",
          start: 9,
          end: 18,
          timeZone: "UTC",
          telegram: true,
        },
        revision: 2,
      },
    ],
    ["channel", "c1", { language: "en", revision: 5 }],
  ]);
  assert.equal(result.revisions.assistant, 3);
});

test("the Work save sends one request and takes both revisions from the answer", async () => {
  const sent = [];
  const base = workServer(
    { revision: 4, projectIds: [] },
    { revision: 7, autonomous: false, maxMembers: 4, runTimeoutMinutes: 30 },
  );
  const result = await runSaveChain({
    steps: [
      workStep({
        assistantId: "home",
        label: "Work",
        withTeam: true,
        save: async (id, body) => {
          sent.push([id, body]);
          return { access: { revision: 5 }, team: { revision: 8 } };
        },
      }),
    ],
    values: { ...base, projectIds: ["p1"], maxMembers: 6 },
    base,
    revisions: { access: 4, team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0][1]).sort(), ["access", "team"]);
  assert.deepEqual(result.revisions, { access: 5, team: 8 });
});

test("creating an agent treats a restart request as an error", async () => {
  const result = await runSaveChain({
    steps: [
      createStep({
        label: "Create agent",
        create: async () => {
          throw Object.assign(new Error("restart"), {
            code: "ASSISTANT_RESTART_REQUIRED",
          });
        },
      }),
    ],
    values: { name: "Fresh", shell: "off" },
    base: {},
    ask: async () => {
      throw new Error("must not ask");
    },
  });
  assert.equal(result.status, "error");
});

test("a memory note is saved against the hash it was loaded with", async () => {
  const sent = [];
  const saveMemory = async (id, body) => {
    sent.push(body);
    return { hash: "h2", content: body.content };
  };
  const step = memoryStep({
    assistantId: "home",
    name: "USER.md",
    file: { hash: "h1" },
    label: "Memory",
    saveMemory,
  });
  await runSaveChain({
    steps: [step],
    values: { content: "tea" },
    base: { content: "" },
  });
  const missing = memoryStep({
    assistantId: "home",
    name: "MEMORY.md",
    file: { missing: true },
    label: "Memory",
    saveMemory,
  });
  await runSaveChain({
    steps: [missing],
    values: { content: "x" },
    base: { content: "" },
  });
  assert.deepEqual(sent, [
    { name: "USER.md", content: "tea", expectedHash: "h1" },
    { name: "MEMORY.md", content: "x", expectedMissing: true },
  ]);
});
