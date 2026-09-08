import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { NativeEventReader } from "../../server/features/pipelines/native-reader.js";
const { NativePipelineDriver } =
  await import("../../server/features/pipelines/native-driver.js").catch(() => ({}));
const identity = {
  sessionId: "session",
  runId: "run",
  nodeId: "node",
  attemptId: "attempt",
  turnId: "turn",
};
test("native driver waits for process exit despite terminal events and reconstructs after restart", async (t) => {
  assert.equal(typeof NativePipelineDriver, "function");
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "agentpier-native-reader-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, "sessions"));
  const session = {
    id: "session",
    tool: "codex",
    status: "running",
    pipeline: { ...identity, headless: true },
    createdAt: "2026-09-07T00:00:00.000Z",
  };
  const sessions = { get: async () => session };
  const bindings = [];
  const deps = {
    dataDir,
    sessions,
    chat: { initialize: (_session, id) => bindings.push(id) },
  };
  const driver = new NativePipelineDriver(deps);
  const file = path.join(dataDir, "sessions/session.events.jsonl");
  await fs.writeFile(
    file,
    '{"type":"thread.started","thread_id":"native-thread"}\n{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}\n',
  );
  assert.equal((await driver.inspect(identity)).status, "running");
  session.status = "stopped";
  session.exitCode = 7;
  const restarted = new NativePipelineDriver(deps);
  const outcome = await restarted.inspect(identity);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 7);
  assert.equal(outcome.nativeId, "native-thread");
  assert.deepEqual(outcome.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(bindings.includes("native-thread"), true);
  await assert.rejects(driver.inspect({ ...identity, runId: "another" }), /ownership/i);
});
test("frozen account drift blocks launch before any process while key rotation is permitted", async () => {
  assert.equal(typeof NativePipelineDriver, "function");
  const account = {
    id: "account",
    kind: "managed",
    tool: "codex",
    provider: { id: "openrouter", modelId: "a" },
    hasSecret: true,
  };
  const frozen = {
    id: "profile",
    name: "Profile",
    accountSnapshot: {
      id: "account",
      kind: "managed",
      tool: "codex",
      provider: { id: "openrouter", modelId: "a" },
    },
    config: {
      accountId: "account",
      cliTool: "codex",
      models: { default: "" },
      permissions: { mode: "never" },
      prompts: { role: "role" },
    },
  };
  let starts = 0;
  const driver = new NativePipelineDriver({
    dataDir: "/unused",
    accounts: { get: () => account },
    lifecycle: {
      launch: async (body, _login, trusted) => {
        trusted.validateAccount(account);
        starts++;
        return { id: trusted.id, createdAt: "now" };
      },
    },
  });
  await driver.start({
    ...identity,
    profileSnapshot: frozen,
    cwd: "/unused",
    prompt: "task",
  });
  assert.equal(starts, 1);
  account.hasSecret = false;
  await driver.start({
    ...identity,
    profileSnapshot: frozen,
    cwd: "/unused",
    prompt: "task",
  });
  assert.equal(starts, 2);
  account.provider.modelId = "b";
  await assert.rejects(
    driver.start({
      ...identity,
      profileSnapshot: frozen,
      cwd: "/unused",
      prompt: "task",
    }),
    /changed/i,
  );
  assert.equal(starts, 2);
});
test("native activity advances only with new bytes and reconstructs its timestamp from disk", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-native-activity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "sessions"));
  const file = path.join(root, "sessions/s.events.jsonl");
  await fs.writeFile(file, '{"type":"turn.started"}\n');
  const first = new Date("2026-09-07T00:00:00Z"),
    second = new Date("2026-09-07T00:01:00Z");
  await fs.utimes(file, first, first);
  const reader = new NativeEventReader(root);
  assert.equal((await reader.read("s", "codex")).lastActivityAt, first.toISOString());
  await fs.utimes(file, second, second);
  assert.equal((await reader.read("s", "codex")).lastActivityAt, first.toISOString());
  await fs.appendFile(file, '{"type":"turn.completed"}\n');
  await fs.utimes(file, second, second);
  assert.equal((await reader.read("s", "codex")).lastActivityAt, second.toISOString());
  assert.equal(
    (await new NativeEventReader(root).read("s", "codex")).lastActivityAt,
    second.toISOString(),
  );
});
test("malformed appended native events remain errors on repeated reads until replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-native-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "sessions"));
  const file = path.join(root, "sessions/s.events.jsonl");
  await fs.writeFile(file, '{"type":"turn.completed"}\n');
  const reader = new NativeEventReader(root);
  assert.equal((await reader.read("s", "codex")).result, "completed");
  await fs.appendFile(file, '{broken}\n{"type":"turn.completed"}\n');
  for (let poll = 0; poll < 3; poll++)
    await assert.rejects(reader.read("s", "codex"), /invalid JSONL/);
  await fs.writeFile(
    `${file}.replacement`,
    '{"type":"thread.started","thread_id":"new-thread"}\n',
  );
  await fs.rename(`${file}.replacement`, file);
  const recovered = await reader.read("s", "codex");
  assert.equal(recovered.nativeId, "new-thread");
  assert.equal(recovered.result, undefined);
});

test("central frozen provider, connection and source drift cannot create a native turn", async (t) => {
  const { AccountStore } =
    await import("../../server/features/accounts/account-store.js");
  const { ProviderConnections } =
    await import("../../server/features/providers/provider-connections.js");
  const { PipelineDefinitions } =
    await import("../../server/features/pipelines/pipeline-definitions.js");
  const { ProviderAccess } =
    await import("../../server/features/providers/provider-access.js");
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-frozen-provider-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir: root });
  const accounts = new AccountStore({
    dataDir: root,
    home: root,
    providerConnections: connections,
  });
  const source = accounts.create({ name: "Source", tool: "codex" });
  const connection = connections.create({
    name: "Fixture",
    providerId: "openrouter",
    apiKey: "synthetic-key",
  });
  const definitions = new PipelineDefinitions({ dataDir: root, accounts });
  const modelId = accounts.providerCatalog.list({
    providerId: "openrouter",
    tool: "codex",
  })[0].modelId;
  const profile = definitions.saveProfile({
    name: "Fixture",
    enabled: true,
    config: {
      accountId: source.id,
      cliTool: "codex",
      providerConnectionId: connection.id,
      models: { available: [modelId], default: modelId },
      permissions: { mode: "never" },
      run: { autonomous: true },
      prompts: { role: "", kickoff: "Task", params: [] },
    },
  });
  const pipeline = definitions.savePipeline({
    name: "Fixture",
    graph: {
      entry: "work",
      nodes: [{ id: "work", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  const frozen = definitions.snapshot(pipeline.id).profiles[profile.id];
  const access = new ProviderAccess({
    accounts,
    connections,
    providerCatalog: accounts.providerCatalog,
  });
  let starts = 0;
  const driver = new NativePipelineDriver({
    dataDir: root,
    accounts,
    lifecycle: {
      launch: async (body, _login, trusted) => {
        const resolved = access.resolve(body);
        trusted.validateAccount(resolved.account);
        starts++;
        return { id: trusted.id, createdAt: "now" };
      },
    },
  });
  const launch = (snapshot) =>
    driver.start({ ...identity, profileSnapshot: snapshot, cwd: root, prompt: "Task" });
  await launch(frozen);
  assert.equal(starts, 1);
  const changedProvider = structuredClone(frozen);
  changedProvider.providerConnectionSnapshot.providerId = "zai";
  await assert.rejects(launch(changedProvider), /provider configuration changed/i);
  const changedConnection = structuredClone(frozen);
  changedConnection.providerConnectionSnapshot.id = "different";
  await assert.rejects(launch(changedConnection), /provider configuration changed/i);
  const missing = structuredClone(frozen);
  delete missing.providerConnectionSnapshot;
  await assert.rejects(launch(missing), /frozen provider/i);
  accounts.update(source.id, { name: "Source", provider: { id: "openrouter", modelId } });
  await assert.rejects(launch(frozen), /account configuration changed/i);
  assert.equal(starts, 1);
});
