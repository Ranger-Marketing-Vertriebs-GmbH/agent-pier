import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryCounts,
  flaggedIds,
  problemTotal,
  visibleSections,
} from "../../web/features/connections/connection-categories.js";
import {
  currentGrant,
  grantAccessBody,
  grantableAgents,
  mcpAgents,
  mcpServersWith,
  sshGrantsBody,
} from "../../web/features/connections/agent-grants.js";
import { runEach, runSummary } from "../../web/features/connections/bulk-run.js";
import {
  boundClis,
  mcpItems,
  mcpLocation,
  mcpSource,
} from "../../web/features/connections/connection-items.js";
import { deleteImpact, grantHolders } from "../../web/features/connections/ssh-bulk.js";

const category = (total, problems = [], warnings = []) => ({
  total,
  problems,
  warnings,
  unknown: [],
});

test("services are a category only while agents are on", () => {
  assert.deepEqual(visibleSections(true), [
    "models",
    "services",
    "mcp-servers",
    "ssh",
    "secrets",
    "github",
  ]);
  assert.equal(visibleSections(false).includes("services"), false);
  assert.equal(visibleSections(null).includes("services"), false);
});

test("category counts use loaded lists, then problem totals, and never fake a zero", () => {
  const problems = {
    models: category(5, [
      { id: "c1", reasons: ["keyMissing"] },
      { id: "cli", reasons: [] },
    ]),
    services: category(1, [], [{ id: "webSearch", reasons: ["notConfigured"] }]),
    mcp: category(
      4,
      [{ id: "m1", reasons: ["installFailed"] }],
      [
        { id: "m2", reasons: ["updateAvailable"] },
        { id: "m1", reasons: ["updateAvailable"] },
      ],
    ),
    ssh: category(3, [{ id: "h1", reasons: ["testFailed"] }]),
    secrets: null,
    github: category(0),
  };
  const counts = categoryCounts({
    problems,
    lists: {
      connections: [{ id: "c1" }, { id: "c2" }],
      chatgpt: [{ id: "openclaw:1" }],
      ssh: [{ id: "h1" }, { id: "h2" }],
    },
    agentsEnabled: true,
  });
  assert.deepEqual(counts, {
    // Connections and ChatGPT accounts; a native CLI account's problem is not shown.
    models: { count: 3, flagged: 1 },
    services: { count: 3, flagged: 1 },
    "mcp-servers": { count: 4, flagged: 2 },
    ssh: { count: 2, flagged: 1 },
    // A source that failed stays unknown.
    secrets: { count: null, flagged: null },
    // A real zero stays zero.
    github: { count: 0, flagged: 0 },
  });
  assert.equal(problemTotal(counts), 5);
  const off = categoryCounts({
    problems,
    lists: { connections: [{ id: "c1" }], chatgpt: null },
    agentsEnabled: false,
  });
  assert.equal(off.services, undefined);
  assert.equal(off.models.count, 1);
  assert.equal(
    categoryCounts({ problems: null, agentsEnabled: true }).models.count,
    null,
  );
  assert.equal(flaggedIds(null, "ssh"), null);
});

test("grant bodies change one grant and keep the rest of the access policy", () => {
  const policy = {
    revision: 7,
    projectIds: ["p1"],
    pipelineIds: [],
    memoryWrite: true,
    autonomous: false,
    publish: false,
    sshAccesses: [{ accessId: "b", mode: "approval" }],
    secretIds: ["s2"],
    github: { credentialId: "gh-1", level: "read" },
  };
  const base = {
    revision: 7,
    projectIds: ["p1"],
    pipelineIds: [],
    memoryWrite: true,
    autonomous: false,
    publish: false,
  };
  assert.deepEqual(
    grantAccessBody(policy, { kind: "ssh", itemId: "a", mode: "trusted" }),
    {
      ...base,
      sshAccesses: [
        { accessId: "a", mode: "trusted" },
        { accessId: "b", mode: "approval" },
      ],
    },
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "ssh", itemId: "b", mode: null }).sshAccesses,
    [],
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "secret", itemId: "s1", mode: true }).secretIds,
    ["s1", "s2"],
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "secret", itemId: "s2", mode: null }).secretIds,
    [],
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "github", itemId: "gh-2", mode: "write" }).github,
    { credentialId: "gh-2", level: "write" },
  );
  assert.equal(
    grantAccessBody(policy, { kind: "github", itemId: "gh-1", mode: null }).github,
    null,
  );
  // Revoking a profile the agent does not use writes nothing.
  assert.equal(
    grantAccessBody(policy, { kind: "github", itemId: "gh-2", mode: null }),
    null,
  );
  assert.equal(currentGrant(policy, { kind: "ssh", itemId: "b" }), "approval");
  assert.equal(currentGrant(policy, { kind: "secret", itemId: "s2" }), true);
  assert.equal(currentGrant(policy, { kind: "github", itemId: "gh-2" }), null);
  assert.deepEqual(sshGrantsBody(policy, ["c", "a"], "routines").sshAccesses, [
    { accessId: "a", mode: "routines" },
    { accessId: "b", mode: "approval" },
    { accessId: "c", mode: "routines" },
  ]);
  assert.deepEqual(sshGrantsBody(policy, ["b"], null).sshAccesses, []);
});

test("only own, active agents are offered; MCP bindings change only the chosen servers", () => {
  const agents = [
    { id: "own", mcpServers: [] },
    { id: "kept", lifetime: "permanent", teamMemberId: "t", mcpServers: [] },
    { id: "member", lifetime: "task", teamMemberId: "t" },
    { id: "user", userAccess: { mode: "own" }, mcpServers: [] },
    { id: "old", archivedAt: "2026-01-01", mcpServers: [] },
  ];
  assert.deepEqual(
    grantableAgents(agents).map((agent) => agent.id),
    ["own", "kept"],
  );
  assert.deepEqual(
    mcpAgents(agents).map((agent) => agent.id),
    ["own", "kept", "user"],
  );
  assert.deepEqual(mcpServersWith(["x"], ["y", "x"], true), ["x", "y"]);
  assert.deepEqual(mcpServersWith(["x", "y", "z"], ["y"], false), ["x", "z"]);
});

test("bulk runs keep at most two items running and report every failure once", async () => {
  let running = 0;
  let peak = 0;
  const calls = [];
  const progress = [];
  const results = await runEach(
    ["a", "b", "c", "d", "e"],
    async (item) => {
      calls.push(item);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, item === "a" ? 15 : 5));
      running -= 1;
      if (item === "c") throw new Error("Permission denied");
      return item.toUpperCase();
    },
    { parallel: 2, onProgress: (done, total) => progress.push(`${done}/${total}`) },
  );
  assert.equal(peak, 2);
  assert.deepEqual(calls.sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(
    results.map((result) => [result.item, result.ok]),
    [
      ["a", true],
      ["b", true],
      ["c", false],
      ["d", true],
      ["e", true],
    ],
  );
  assert.equal(results[2].error.message, "Permission denied");
  assert.equal(results[0].value, "A");
  assert.deepEqual(progress, ["1/5", "2/5", "3/5", "4/5", "5/5"]);
  assert.deepEqual(runSummary(results), { ok: 4, failed: 1 });
  // Sequential by default.
  let active = 0;
  await runEach([1, 2, 3], async () => {
    active += 1;
    assert.equal(active, 1);
    await Promise.resolve();
    active -= 1;
  });
});

test("SSH bulk actions name who holds a grant and who a delete affects", () => {
  const usage = {
    ssh: {
      h1: {
        agents: [
          { id: "ops", name: "Ops", via: "grant" },
          { id: "ops", name: "Ops", via: "hook" },
          { id: "helper", name: "Helper", via: "lead" },
        ],
        hooks: [{ hookId: "k1", name: "Deploy", agentId: "ops" }],
        sessions: 2,
      },
      h2: {
        agents: [{ id: "research", name: "Research", via: "grant" }],
        hooks: [],
        sessions: 1,
      },
    },
  };
  const selected = [{ id: "h1" }, { id: "h2" }];
  assert.deepEqual(grantHolders(selected, usage), [
    { id: "ops", name: "Ops" },
    { id: "research", name: "Research" },
  ]);
  assert.deepEqual(deleteImpact(selected, usage), {
    agents: ["Ops", "Helper", "Research"],
    hooks: ["Deploy"],
    sessions: 3,
  });
  assert.equal(deleteImpact([{ id: "h3" }], usage), null);
  assert.equal(
    deleteImpact(selected, {
      ssh: { ...usage.ssh, h2: { ...usage.ssh.h2, sessions: null } },
    }).sessions,
    null,
  );
});

test("MCP items group by source and count updates and sign-ins as problems", () => {
  const servers = [
    { id: "m1", name: "Docs", transport: "http", url: "https://docs.test/mcp", clis: [] },
    {
      id: "m2",
      name: "Files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "files"],
      source: { registry: "npm", name: "files", version: "1.0.0" },
      clis: ["codex"],
    },
    { id: "m3", name: "Notes", transport: "stdio", command: "notes", args: [], clis: [] },
  ];
  const items = mcpItems({
    servers,
    accountUsage: {
      mcpServers: {
        m1: { agents: [], sessions: 0, pipelineProfiles: [] },
        m3: { agents: [{ id: "ops", name: "Ops" }], sessions: 0, pipelineProfiles: [] },
      },
    },
    connectionUsage: { mcp: { m1: { changedAt: "2026-10-01T00:00:00Z" } } },
    problems: { mcp: category(3, [{ id: "m3", reasons: ["loginRequired"] }]) },
    updates: new Map([["m2", { version: "1.1.0" }]]),
  });
  assert.deepEqual(
    items.map((item) => [item.id, item.group.key, item.status, item.problem, item.used]),
    [
      ["m1", "remote", "ok", false, false],
      ["m2", "package", "updateAvailable", true, true],
      ["m3", "command", "loginRequired", true, true],
    ],
  );
  assert.equal(items[0].changedAt, "2026-10-01T00:00:00Z");
  assert.equal(items[1].changedAt, null);
  assert.deepEqual(items[2].facets.agent, ["ops"]);
  assert.equal(mcpLocation(servers[1]), "npm files 1.0.0");
  assert.equal(mcpLocation(servers[2]), "notes");
  assert.equal(mcpSource(servers[0]), "remote");
  // Unknown usage and no CLI: not counted as unused.
  assert.equal(mcpItems({ servers: [servers[0]] })[0].used, null);
});

test("binding to CLIs adds supported ones and names the others", () => {
  assert.deepEqual(
    boundClis({ transport: "sse", clis: ["claude"] }, ["codex", "opencode"]),
    {
      clis: ["claude", "opencode"],
      unsupported: ["codex"],
    },
  );
  assert.deepEqual(
    boundClis({ transport: "http", agentPlaceholders: true, clis: [] }, ["claude"]),
    { clis: [], unsupported: ["claude"] },
  );
});
