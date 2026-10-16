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

test("a new packaged server asks for the install confirmation with its preview", async () => {
  const preview = { previewId: "p1", programs: ["a", "b"], dependencyCount: 3 };
  const previews = [];
  const step = mcpServerStep({
    server: null,
    label: "Save",
    saved: async () => {},
    previewPackage: async (input) => previews.push(input) && preview,
    saveServer: async () => assert.fail("must not save before confirmation"),
  });
  const values = {
    ...mcpServerValues(null),
    name: "pkg",
    transport: "stdio",
    source: "package",
    packageName: " x ",
    packageVersion: "1.0.0",
    clis: ["claude"],
  };
  await assert.rejects(step.run({ values, confirmations: {} }), (error) => {
    assert.equal(error.code, "MCP_PACKAGE_INSTALL_REQUIRED");
    assert.deepEqual(step.confirmation(error), {
      kind: "package",
      flags: { confirmInstall: true, previewId: "p1" },
      data: { preview },
    });
    return true;
  });
  assert.deepEqual(previews, [
    { registry: "npm", name: "x", version: "1.0.0", allowScripts: false },
  ]);
});

test("the confirmed install carries the chosen program and no stdio confirmation", async () => {
  const sent = [];
  const step = mcpServerStep({
    server: null,
    label: "Save",
    saved: async () => {},
    previewPackage: async () => ({ previewId: "p1", programs: ["a", "b"] }),
    chosenProgram: () => "b",
    saveServer: async (_server, body) => sent.push(body) && { id: "n1" },
  });
  const values = {
    ...mcpServerValues(null),
    name: "pkg",
    transport: "stdio",
    source: "package",
    packageName: "x",
    packageVersion: "1.0.0",
    clis: ["claude"],
  };
  const { result, asked } = await chain(step, values, mcpServerValues(null));
  assert.equal(result.status, "saved");
  assert.deepEqual(asked, ["package"]);
  assert.equal(sent[0].program, "b");
  assert.equal(sent[0].confirmInstall, true);
  assert.equal(sent[0].previewId, "p1");
  assert.equal(sent[0].confirmStdio, undefined);
  assert.deepEqual(sent[0].clis, ["claude"]);
});

test("an own-command server switching to a package is previewed and sent with its source", async () => {
  const server = {
    id: "s1",
    name: "own",
    transport: "stdio",
    command: "/bin/sh",
    args: [],
    headerNames: [],
    envNames: [],
    revision: 4,
    clis: [],
  };
  const sent = [];
  const step = mcpServerStep({
    server,
    label: "Save",
    saved: async () => {},
    previewPackage: async () => ({ previewId: "p2", programs: ["x"] }),
    saveServer: async (_server, body) => {
      sent.push(body);
      return { ...server, source: { status: "installing" } };
    },
  });
  const values = {
    ...mcpServerValues(server),
    source: "package",
    packageName: "x",
    packageVersion: "1.0.0",
  };
  await assert.rejects(step.run({ values, revision: 4, confirmations: {} }), {
    code: "MCP_PACKAGE_INSTALL_REQUIRED",
  });
  await step.run({
    values,
    revision: 4,
    confirmations: { confirmInstall: true, previewId: "p2" },
  });
  assert.equal(sent[0].command, undefined);
  assert.deepEqual(sent[0].source, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    allowScripts: false,
  });
  assert.equal(sent[0].confirmInstall, true);
  assert.equal(sent[0].previewId, "p2");
});

test("an edit of a packaged server is never previewed again", async () => {
  const server = {
    id: "s2",
    name: "pkg",
    transport: "stdio",
    command: "/data/node",
    args: ["/data/x.js"],
    source: {
      registry: "npm",
      name: "x",
      version: "1.0.0",
      status: "ready",
      leadingArgs: 1,
    },
    headerNames: [],
    envNames: [],
    revision: 2,
    clis: [],
  };
  const sent = [];
  const step = mcpServerStep({
    server,
    label: "Save",
    saved: async () => {},
    previewPackage: async () => assert.fail("no preview for an installed package"),
    saveServer: async (_server, body) => sent.push(body) && { ...server, revision: 3 },
  });
  const values = { ...mcpServerValues(server), args: "--owner" };
  await step.run({ values, revision: 2, confirmations: {} });
  assert.deepEqual(sent[0], { revision: 2, args: ["--owner"] });
});

test("a create carries its origin; an update never does", async () => {
  const bodies = [];
  const saveServer = async (server, body) => {
    bodies.push(body);
    return { id: "s1" };
  };
  const values = { ...mcpServerValues(null), name: "docs", url: "https://a.example/mcp" };
  await mcpServerStep({
    server: null,
    label: "",
    origin: "paste",
    saveServer,
    saved: async () => {},
  }).run({ values, confirmations: {} });
  await mcpServerStep({
    server: docs,
    label: "",
    origin: "paste",
    saveServer,
    saved: async () => {},
  }).run({
    values: { ...mcpServerValues(docs), name: "docs2" },
    revision: 4,
    confirmations: {},
  });
  assert.equal(bodies[0].origin, "paste");
  assert.equal(bodies[1].origin, undefined);
});
