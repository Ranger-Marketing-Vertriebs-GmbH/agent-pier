import test from "node:test";
import assert from "node:assert/strict";
import { connectionProblems } from "../../server/features/accounts/connection-problems.js";

const fail = () => {
  throw new Error("unreadable");
};
const failedTest = (hostKeyMismatch) => ({ ok: false, hostKeyMismatch });
const detail = (version) => ({
  options: [{ kind: "npm", identifier: "@acme/mcp", version }],
});

function services(overrides = {}) {
  const hosts = [
    { id: "ok", lastTest: { ok: true } },
    { id: "untested", lastTest: null },
    { id: "failed", lastTest: failedTest(false) },
    { id: "moved", lastTest: failedTest(true) },
  ];
  return {
    assistantFeature: { enabled: true },
    assistants: {
      store: {
        listAssistants: () => [
          { id: "a" },
          {
            id: "m",
            teamMemberId: "t",
            lifetime: "task",
            inherited: { github: { credentialId: "narrow", level: "write" } },
          },
        ],
      },
      workflows: {
        access: { get: () => ({ github: { credentialId: "narrow", level: "read" } }) },
      },
    },
    sshAccesses: { list: () => hosts, withLastTests: (list) => list },
    secrets: { list: () => [{ id: "s1" }] },
    providerConnections: {
      list: () => [
        { id: "router", launchable: true },
        { id: "nokey", launchable: false },
      ],
    },
    accounts: { list: () => [{ id: "local-codex" }] },
    assistantModelAccounts: {
      capabilities: () => [
        { id: "c1", status: "ok" },
        { id: "c2", status: "expired" },
        { id: "c3", status: "expiring" },
        { id: "c4", status: "offline" },
      ],
    },
    repositories: {
      listCredentials: () => [
        { id: "fine", tokenCheck: { state: "valid", scopes: ["repo"] } },
        { id: "dead", tokenCheck: { state: "expired" } },
        { id: "soon", tokenCheck: { state: "expiring" } },
        { id: "narrow", tokenCheck: { state: "valid", scopes: ["read:org"] } },
        { id: "fresh" },
      ],
    },
    assistantWebSearch: { get: () => ({ ready: false }) },
    mcpServerChanges: {
      list: () => [
        { id: "healthy" },
        { id: "broken", source: { status: "failed" } },
        {
          id: "codex",
          cliStatus: {
            codex: {
              status: "written",
              oauth: { state: "connected", accounts: [{ state: "failed" }] },
            },
          },
        },
        { id: "agent", oauthStatus: "login-required" },
        { id: "clash", cliStatus: { claude: { status: "conflict" } } },
        {
          id: "old",
          directoryOrigin: { name: "io.acme/mcp" },
          source: {
            registry: "npm",
            name: "@acme/mcp",
            version: "1.0.0",
            status: "ready",
          },
        },
      ],
    },
    mcpDirectory: { cachedDetail: () => detail("1.2.0") },
    ...overrides,
  };
}

const ids = (list) => list.map((item) => [item.id, item.reasons]);

test("problems and warnings per category come from stored state", async () => {
  const result = await connectionProblems(services());
  assert.equal(result.agentsEnabled, true);
  assert.equal(result.ssh.total, 4);
  assert.deepEqual(ids(result.ssh.problems), [
    ["failed", ["testFailed"]],
    ["moved", ["hostKeyMismatch"]],
  ]);
  assert.deepEqual(ids(result.mcp.problems), [
    ["broken", ["installFailed"]],
    ["codex", ["loginRequired"]],
    ["agent", ["loginRequired"]],
    ["clash", ["cliError"]],
  ]);
  assert.deepEqual(ids(result.mcp.warnings), [["old", ["updateAvailable"]]]);
  assert.deepEqual(result.mcp.unknown, []);
  assert.equal(result.models.total, 3);
  assert.deepEqual(ids(result.models.problems), [
    ["nokey", ["keyMissing"]],
    ["c2", ["signInExpired"]],
  ]);
  assert.deepEqual(ids(result.models.warnings), [["c3", ["signInExpiring"]]]);
  assert.deepEqual(result.models.unknown, ["cliAccountSignIn"]);
  assert.deepEqual(ids(result.github.problems), [
    ["dead", ["tokenExpired"]],
    ["narrow", ["missingScopes"]],
  ]);
  assert.deepEqual(ids(result.github.warnings), [["soon", ["tokenExpiring"]]]);
  assert.deepEqual(result.secrets, { total: 1, problems: [], warnings: [], unknown: [] });
  assert.deepEqual(ids(result.services.warnings), [["webSearch", ["notConfigured"]]]);
});

test("a source that fails is null and unread checks are named, never zero", async () => {
  const result = await connectionProblems(
    services({
      sshAccesses: { list: fail },
      secrets: { list: fail },
      mcpDirectory: { cachedDetail: () => undefined },
      assistants: { store: { listAssistants: fail } },
    }),
  );
  assert.equal(result.ssh, null);
  assert.equal(result.secrets, null);
  assert.deepEqual(result.mcp.warnings, []);
  assert.deepEqual(result.mcp.unknown, ["updates"]);
  assert.deepEqual(result.github.unknown, ["scopes"]);
  assert.deepEqual(ids(result.github.problems), [["dead", ["tokenExpired"]]]);
});

test("while agents are off only shared credentials are counted", async () => {
  const result = await connectionProblems(
    services({ assistantFeature: { enabled: false } }),
  );
  assert.equal(result.agentsEnabled, false);
  assert.equal(result.services, null);
  assert.deepEqual(ids(result.models.problems), [["nokey", ["keyMissing"]]]);
  assert.deepEqual(result.github.unknown, []);
  assert.deepEqual(ids(result.github.problems), [["dead", ["tokenExpired"]]]);
});
