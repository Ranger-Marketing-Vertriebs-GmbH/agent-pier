import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveRights,
  hookDefaults,
  hookEligible,
  hookTools,
  rightsInput,
  shellChoices,
} from "../../server/features/assistants/agent-hook-rights.js";

const none = {
  telegram: false,
  research: false,
  coding: false,
  shell: "off",
  sshHosts: [],
  folders: {},
  memory: false,
  mcp: false,
  secrets: false,
  webSearch: false,
  webFetch: false,
};

test("hookEligible admits own agents and permanent members only, with reminders on", () => {
  const own = { id: "a", capabilities: { reminders: true } };
  assert.equal(hookEligible(own), true);
  assert.equal(hookEligible({ ...own, capabilities: { reminders: false } }), false);
  assert.equal(hookEligible({ ...own, archivedAt: "x" }), false);
  assert.equal(hookEligible({ ...own, userAccess: { mode: "shared" } }), false);
  assert.equal(hookEligible({ ...own, userAccess: { mode: "own" } }), false);
  assert.equal(hookEligible({ ...own, teamMemberId: "m", lifetime: "task" }), false);
  assert.equal(hookEligible({ ...own, teamMemberId: "m", lifetime: "permanent" }), true);
  assert.equal(hookEligible(null), false);
});

test("shellChoices offers off plus the agent's own level", () => {
  assert.deepEqual(shellChoices("off"), ["off"]);
  assert.deepEqual(shellChoices("approval"), ["off", "approval"]);
  assert.deepEqual(shellChoices("full"), ["off", "full"]);
});

test("rightsInput refuses anything above the agent's ceiling", () => {
  const ceiling = {
    ...none,
    shell: "approval",
    sshHosts: ["h1"],
    folders: { p: "read" },
  };
  assert.throws(() => rightsInput({ shell: "full" }, ceiling), { status: 400 });
  assert.throws(() => rightsInput({ shell: "approval" }, { ...ceiling, shell: "full" }), {
    status: 400,
  });
  assert.throws(() => rightsInput({ sshHosts: ["h2"] }, ceiling), { status: 400 });
  assert.throws(() => rightsInput({ folders: { p: "write" } }, ceiling), { status: 400 });
  assert.throws(() => rightsInput({ extra: true }, ceiling), { status: 400 });
  assert.deepEqual(rightsInput({}, ceiling), hookDefaults);
});

test("rightsInput accepts ticks within the ceiling and rejects malformed input", () => {
  const ceiling = {
    ...none,
    telegram: true,
    research: true,
    shell: "full",
    sshHosts: ["h1", "h2"],
    folders: { p: "write", q: "read" },
  };
  assert.deepEqual(
    rightsInput(
      {
        telegram: true,
        research: true,
        shell: "full",
        sshHosts: ["h1", "h1", "h2"],
        folders: { p: "read", q: "read" },
        notify: false,
      },
      ceiling,
    ),
    {
      ...hookDefaults,
      notify: false,
      telegram: true,
      research: true,
      shell: "full",
      sshHosts: ["h1", "h2"],
      folders: { p: "read", q: "read" },
    },
  );
  assert.throws(() => rightsInput({ coding: true }, ceiling), { status: 400 });
  assert.throws(() => rightsInput({ memory: true }, ceiling), { status: 400 });
  assert.throws(() => rightsInput({ secrets: true }, ceiling), { status: 400 });
  assert.equal(
    rightsInput({ secrets: true }, { ...ceiling, secrets: true }).secrets,
    true,
  );
  assert.throws(() => rightsInput({ secrets: "yes" }, { ...ceiling, secrets: true }), {
    status: 400,
  });
  for (const bad of [
    null,
    [],
    "x",
    { notify: "yes" },
    { shell: 3 },
    { sshHosts: "h1" },
    { sshHosts: [1] },
    { folders: [] },
    { folders: { p: "admin" } },
    { folders: { zz: "read" } },
  ])
    assert.throws(() => rightsInput(bad, ceiling), { status: 400 }, JSON.stringify(bad));
  const many = { ...none, sshHosts: Array.from({ length: 101 }, (_, i) => `h${i}`) };
  assert.throws(() => rightsInput({ sshHosts: many.sshHosts }, many), { status: 400 });
});

test("a new hook may not read the agent's secrets", () => {
  assert.equal(hookDefaults.secrets, false);
  assert.equal(rightsInput({}, { ...none, secrets: true }).secrets, false);
});

test("a stored hook without the secrets field runs without secrets", () => {
  const { secrets: _secrets, ...legacy } = { ...hookDefaults, sshHosts: [], folders: {} };
  assert.equal(effectiveRights(legacy, { ...none, secrets: true }).secrets, false);
  assert.equal(
    effectiveRights({ ...legacy, secrets: true }, { ...none, secrets: true }).secrets,
    true,
  );
  // Secrets the agent no longer receives are off for the run.
  assert.equal(effectiveRights({ ...legacy, secrets: true }, none).secrets, false);
});

test("effectiveRights caps every tick live", () => {
  const saved = {
    ...hookDefaults,
    research: true,
    coding: true,
    shell: "full",
    sshHosts: ["h1", "h2"],
    folders: { p: "write", q: "read" },
    memory: true,
    mcp: true,
  };
  const lower = {
    ...none,
    shell: "approval",
    sshHosts: ["h2"],
    folders: { p: "read" },
    research: true,
  };
  assert.deepEqual(effectiveRights(saved, lower), {
    ...hookDefaults,
    research: true,
    shell: "approval",
    sshHosts: ["h2"],
    folders: { p: "read" },
  });
  assert.equal(
    effectiveRights({ ...saved, shell: "approval" }, { ...lower, shell: "full" }).shell,
    "off",
  );
  assert.equal(
    effectiveRights({ ...saved, shell: "full" }, { ...lower, shell: "full" }).shell,
    "full",
  );
});

test("hookTools builds toolsAllow from ticks only", () => {
  const base = ["session_status", "memory_search", "memory_get"];
  assert.deepEqual(hookTools(hookDefaults, none), base);
  const all = hookTools(
    {
      ...hookDefaults,
      research: true,
      coding: true,
      shell: "full",
      sshHosts: ["h"],
      memory: true,
      mcp: true,
    },
    { ...none, webSearch: true, webFetch: false },
  );
  for (const t of [
    "web_search",
    "agentpier_workspace",
    "exec",
    "process",
    "agentpier_ssh",
    "read",
    "write",
    "edit",
    "*__*",
  ])
    assert.ok(all.includes(t), t);
  for (const t of [
    "web_fetch",
    "browser",
    "agentpier_routine",
    "agentpier_reminder",
    "agentpier_hook",
    "agentpier_share_file",
    "agentpier_team_ask",
    "agentpier_goal",
  ])
    assert.ok(!all.includes(t), t);
  assert.ok(
    hookTools({ ...hookDefaults, folders: { p: "read" } }, none).includes(
      "agentpier_workspace",
    ),
  );
});
