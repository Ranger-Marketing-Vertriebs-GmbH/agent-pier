import test from "node:test";
import assert from "node:assert/strict";
import {
  matchingProfile,
  profileSwitches,
} from "../../web/features/assistants/wizard/wizard-profiles.js";
import {
  duplicateFields,
  emptyDraft,
  firstProblem,
  forUserAgent,
  stepProblem,
} from "../../web/features/assistants/wizard/wizard-draft.js";
import {
  createBody,
  creationPlan,
  runCreation,
} from "../../web/features/assistants/wizard/wizard-creation.js";

const off = {
  memory: false,
  reminders: false,
  webSearch: false,
  webFetch: false,
  documents: false,
  readPdfs: false,
  browser: false,
  createImages: false,
  shell: "off",
};

test("profiles set exactly the switches of handoff 5.3 step 3", () => {
  assert.deepEqual(profileSwitches("talk"), { ...off, memory: true });
  const research = {
    ...off,
    memory: true,
    reminders: true,
    webSearch: true,
    webFetch: true,
    documents: true,
    readPdfs: true,
  };
  assert.deepEqual(profileSwitches("research"), research);
  assert.deepEqual(profileSwitches("assist"), { ...research, browser: true });
  assert.deepEqual(profileSwitches("ops"), {
    ...research,
    browser: true,
    shell: "approval",
  });
  assert.equal(profileSwitches("unknown"), null);
  // Every switch stays editable: a changed switch leaves the profile.
  assert.equal(matchingProfile(profileSwitches("assist")), "assist");
  assert.equal(matchingProfile({ ...profileSwitches("assist"), createImages: true }), "");
});

const source = {
  id: "home",
  name: "Home",
  instructions: "Be kind.",
  model: { connectionId: "router", modelId: "m1" },
  capabilities: { memory: true, webSearch: true, browser: true, createImages: false },
  shell: "approval",
  skills: ["gh", "curl"],
  mcpServers: ["cal"],
  browserVisible: true,
  template: { id: "x", revision: "r" },
  userAccess: { mode: "own", members: [{ userId: "u", level: "chat" }] },
  heartbeat: { enabled: true },
  telegramSenders: { count: 2 },
};
const policy = {
  revision: 4,
  projectIds: ["p2", "p1"],
  projectFiles: { p1: "write", p3: "none" },
  pipelineIds: ["pl"],
  autonomous: true,
  publish: true,
  memoryWrite: true,
  sshAccesses: [{ accessId: "s", mode: "trusted", extra: 1 }],
  github: { credentialId: "g", level: "read", scopes: ["repo"] },
  secretIds: ["k"],
};
const team = {
  revision: 3,
  usage: "autonomous",
  autonomous: true,
  memberShellSsh: true,
  maxMembers: 4,
  runTimeoutMinutes: 20,
};

test("duplicate copies exactly the fields of 5.3.1 and nothing else", () => {
  const copy = duplicateFields(source, policy, team, (name) => `Kopie von ${name}`);
  assert.deepEqual(copy, {
    name: "Kopie von Home",
    instructions: "Be kind.",
    connectionId: "router",
    modelId: "m1",
    memory: true,
    reminders: false,
    webSearch: true,
    webFetch: false,
    documents: false,
    readPdfs: false,
    browser: true,
    createImages: false,
    shell: "approval",
    skills: ["curl", "gh"],
    projectIds: ["p1", "p2"],
    projectFiles: { p1: "write" },
    pipelineIds: ["pl"],
    autonomous: true,
    publish: true,
    mcpServers: ["cal"],
    sshAccesses: [{ accessId: "s", mode: "trusted" }],
    github: { credentialId: "g", level: "read" },
    secretIds: ["k"],
    team: {
      usage: "autonomous",
      autonomous: true,
      memberShellSsh: true,
      maxMembers: 4,
      runTimeoutMinutes: 20,
    },
  });
  // Memory, Telegram, hooks, routines, the allowlist, browser profile and window,
  // users and template provenance never come along.
  for (const key of [
    "template",
    "userAccess",
    "heartbeat",
    "telegramSenders",
    "browserVisible",
    "memoryWrite",
    "routine",
    "telegramToken",
  ])
    assert.equal(key in copy, false, key);
  assert.equal(duplicateFields({ name: "A" }, null, null, (n) => n).team, null);
});

test("the plan follows the draft; agents of users keep only folders and MCP", () => {
  const d = { ...emptyDraft(), name: "A", connectionId: "c", modelId: "m" };
  assert.deepEqual(creationPlan(d), ["create", "capabilities"]);
  assert.deepEqual(creationPlan({ ...d, ...profileSwitches("talk") }), ["create"]);
  const full = {
    ...d,
    projectIds: ["p"],
    mcpServers: ["m"],
    team: { usage: "suggest" },
    telegramToken: "1:abc",
    heartbeatEnabled: true,
    routine: { name: "Daily", prompt: "Sum up", time: "08:30" },
  };
  assert.deepEqual(creationPlan(full), [
    "create",
    "capabilities",
    "access",
    "mcp",
    "team",
    "telegram",
    "heartbeat",
    "routine",
  ]);
  const user = forUserAgent({ ...full, owner: "u", projectFiles: { p: "read" } });
  assert.deepEqual(creationPlan(user), ["create", "capabilities", "access", "mcp"]);
  assert.deepEqual(createBody(user).userAccess, {
    mode: "own",
    members: [{ userId: "u", level: "chat" }],
  });
  assert.equal("shell" in createBody(user), false);
  // Web tools come with the capabilities step, never with the create request.
  assert.equal(createBody(full).capabilities.webSearch, false);
});

test("steps name what blocks Weiter", () => {
  const d = emptyDraft();
  assert.equal(stepProblem("start", { ...d, start: "template" }), "template");
  assert.equal(stepProblem("identity", d), "name");
  assert.equal(stepProblem("identity", { ...d, name: "A" }), "model");
  assert.equal(
    stepProblem("channels", { ...d, routine: { name: "R", prompt: "P", time: "25:00" } }),
    "routineTime",
  );
  assert.equal(firstProblem({ ...d, name: "A", connectionId: "c", modelId: "m" }), "");
});

function fakeApi({ fail = {}, confirm = {} } = {}) {
  const calls = [];
  const answer =
    (name) =>
    async (...args) => {
      calls.push([name, ...args]);
      if (confirm[name] && !args.at(-1)?.confirmShell && !args.at(-1)?.confirmRestart) {
        const error = new Error("confirm");
        error.code = confirm[name];
        error.required = ["confirmShell"];
        throw error;
      }
      if (fail[name]?.length) throw new Error(fail[name].shift());
      return name === "create" ? { id: "new", revision: 1 } : { revision: 2 };
    };
  return {
    calls,
    api: {
      create: answer("create"),
      createUserAgent: answer("createUserAgent"),
      update: answer("update"),
      saveWork: answer("saveWork"),
      createChannel: answer("createChannel"),
      createRoutine: answer("createRoutine"),
      revision: async (_id, kind) => ({ assistant: 5, access: 7, team: 9 })[kind],
    },
  };
}
const env = { origin: "http://x", language: "de", routineRequestId: "r-1" };
const fullDraft = {
  ...emptyDraft(),
  name: "Ops",
  connectionId: "c",
  modelId: "m",
  projectIds: ["p"],
  telegramToken: "1:abc",
  routine: { name: "Daily", prompt: "Sum up", time: "08:30" },
};

test("a failed later step keeps the agent; retry repeats only that step", async () => {
  const { api, calls } = fakeApi({ fail: { createChannel: ["Bot-Token ungültig"] } });
  const plan = creationPlan(fullDraft);
  const first = await runCreation({
    plan,
    d: fullDraft,
    api,
    ask: async () => false,
    env,
  });
  assert.equal(first.agent.id, "new");
  assert.deepEqual(
    Object.fromEntries(Object.entries(first.results).map(([k, v]) => [k, v.status])),
    {
      create: "done",
      capabilities: "done",
      access: "done",
      telegram: "failed",
      routine: "done",
    },
  );
  assert.equal(first.results.telegram.error, "Bot-Token ungültig");
  // Revisions are read right before each request.
  assert.deepEqual(calls.find((c) => c[0] === "saveWork")[2].access.revision, 7);
  assert.equal(calls.find((c) => c[0] === "update")[2].revision, 5);
  assert.deepEqual(calls.find((c) => c[0] === "createRoutine")[2], {
    clientRequestId: "r-1",
    name: "Daily",
    prompt: "Sum up",
    trigger: { kind: "cron", expr: "30 8 * * *", tz: "UTC" },
  });
  // Never Telegram: the bot is paired only after creating, and the server refuses a
  // routine for an unpaired chat (tests/blackbox/agent-wizard-telegram-routine.test.js).
  const old = await runCreation({
    plan,
    d: { ...fullDraft, routine: { ...fullDraft.routine, telegram: true } },
    api,
    ask: async () => false,
    env,
  });
  assert.equal(old.results.routine.status, "done");
  assert.equal(
    "telegram" in calls.filter((c) => c[0] === "createRoutine").at(-1)[2],
    false,
  );
  const before = calls.length;
  const retried = await runCreation({
    plan,
    d: fullDraft,
    api,
    ask: async () => false,
    env,
    results: first.results,
    agent: first.agent,
    only: "telegram",
  });
  assert.equal(retried.results.telegram.status, "done");
  assert.deepEqual(
    calls.slice(before).map((c) => c[0]),
    ["createChannel"],
  );
});

test("a failed agent stops everything; a refused confirmation sends nothing more", async () => {
  const failed = fakeApi({ fail: { create: ["nope"] } });
  const result = await runCreation({
    plan: creationPlan(fullDraft),
    d: fullDraft,
    api: failed.api,
    ask: async () => true,
    env,
  });
  assert.equal(result.agent, null);
  assert.deepEqual(
    failed.calls.map((c) => c[0]),
    ["create"],
  );
  const shell = { ...fullDraft, shell: "approval" };
  const asked = [];
  const confirmed = fakeApi({
    confirm: { create: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED" },
  });
  const done = await runCreation({
    plan: ["create"],
    d: shell,
    api: confirmed.api,
    ask: async (request) => (asked.push(request.kind), true),
    env,
  });
  assert.deepEqual(asked, ["shell"]);
  assert.equal(done.results.create.status, "done");
  assert.equal(confirmed.calls.at(-1)[1].confirmShell, true);
  const refused = fakeApi({
    confirm: { create: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED" },
  });
  const none = await runCreation({
    plan: ["create", "capabilities"],
    d: shell,
    api: refused.api,
    ask: async () => false,
    env,
  });
  assert.equal(none.results.create.status, "failed");
  assert.equal(refused.calls.length, 1);
});
