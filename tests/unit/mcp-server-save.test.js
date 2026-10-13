import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  mcpServerStep,
  mcpServerValues,
  mcpTargets,
} from "../../web/features/mcp-servers/mcp-server-save.js";

const docs = {
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://a.example/mcp",
  auth: "headers",
  headerNames: ["Authorization"],
  envNames: [],
  clis: [],
  revision: 4,
};
const chain = (step, values, base, answers = []) => {
  const asked = [];
  return runSaveChain({
    steps: [step],
    values,
    base,
    revisions: { mcp: 3 },
    ask: async (request) => {
      asked.push(request.kind);
      return answers.shift() ?? true;
    },
  }).then((result) => ({ result, asked }));
};

test("an edit sends the draft's base revision, not the latest record's", async () => {
  const bodies = [];
  const step = mcpServerStep({
    server: docs,
    label: "Save server",
    saveServer: async (server, body) => bodies.push(body) && { id: "s1", revision: 5 },
    saved: async () => {},
  });
  const base = mcpServerValues(docs);
  const { result } = await chain(step, { ...base, name: "docs2" }, base);
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies[0], { revision: 3, name: "docs2" });
  assert.equal(result.revisions.mcp, 5);
});

test("switching to OAuth asks before deleting stored headers", async () => {
  const bodies = [];
  const step = mcpServerStep({
    server: docs,
    label: "Save server",
    saveServer: async (server, body) => bodies.push(body) && { revision: 5 },
    saved: async () => {},
  });
  const base = mcpServerValues(docs);
  const cancelled = await chain(step, { ...base, auth: "oauth" }, base, [false]);
  assert.equal(cancelled.result.status, "cancelled");
  assert.deepEqual(cancelled.asked, ["oauthSwitch"]);
  assert.equal(bodies.length, 0);
  const confirmed = await chain(step, { ...base, auth: "oauth" }, base);
  assert.equal(confirmed.result.status, "saved");
  assert.equal(bodies[0].auth, "oauth");
});

test("a local command for a newly chosen CLI is confirmed before anything is sent", async () => {
  const bodies = [];
  const step = mcpServerStep({
    server: null,
    label: "Save server",
    saveServer: async (server, body) => bodies.push(body) && { id: "new" },
    saved: async () => {},
  });
  const base = mcpServerValues(null);
  const values = {
    ...base,
    name: "local",
    transport: "stdio",
    command: "npx",
    clis: ["claude"],
  };
  const cancelled = await chain(step, values, base, [false]);
  assert.deepEqual(cancelled.asked, ["cliStdio"]);
  assert.equal(bodies.length, 0);
  const confirmed = await chain(step, values, base);
  assert.equal(confirmed.result.status, "saved");
  assert.equal(bodies[0].confirmStdio, true);
  assert.deepEqual(bodies[0].clis, ["claude"]);
});

test("the server's stdio question and a value refusal come back", async () => {
  let calls = 0;
  const refusal = Object.assign(new Error("literal"), {
    code: "MCP_SERVER_VALUE_REFERENCE",
    field: "cwd",
    status: 400,
  });
  const step = mcpServerStep({
    server: null,
    label: "Save server",
    saveServer: async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error("stdio"), {
          code: "MCP_STDIO_CONFIRMATION_REQUIRED",
        });
      throw refusal;
    },
    saved: async () => {},
  });
  const base = mcpServerValues(null);
  const values = { ...base, name: "local", transport: "stdio", command: "npx" };
  const { result, asked } = await chain(step, values, base);
  assert.deepEqual(asked, ["stdio"]);
  assert.equal(result.status, "error");
  assert.equal(result.error, refusal);
});

test("targets drop CLIs that cannot run the server", () => {
  const values = {
    ...mcpServerValues(null),
    transport: "sse",
    clis: ["claude", "codex"],
  };
  const { wanted, added, clisChanged } = mcpTargets(values, null);
  assert.equal(wanted.includes("codex"), false);
  assert.deepEqual(added, wanted);
  assert.equal(clisChanged, wanted.length > 0);
});
