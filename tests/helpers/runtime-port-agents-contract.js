import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
const quiet = { timeoutMs: 1000, warn: () => {} };

/**
 * The agents, agentFiles and config sub-ports of the runtime port contract
 * (runtime-port-contract.js): the runtime-side agent, its files and memory search,
 * the live configuration with its adoption watch, a view bound to a replaced
 * connection, and all of them while the runtime is unreachable.
 */
export function agentsContract(name, make) {
  const agentId = "ap-1";

  test(`${name}: agents are created, listed, updated and deleted`, async () => {
    const { agents } = await make({});
    await agents.settled();
    assert.equal(typeof (await agents.admitted()), "boolean");
    assert.equal(
      (await agents.list()).agents.some((a) => a.id === agentId),
      false,
    );
    const created = await agents.create({ name: agentId, workspace: "/w", model: "m" });
    assert.equal(created.agentId, agentId);
    await agents.waitListed({ agentId, timeoutMs: 1000 });
    assert.ok((await agents.list()).agents.some((a) => a.id === agentId));
    await agents.update({ agentId, name: "Ada", model: "m2" });
    await agents.delete({ agentId, deleteFiles: false });
    assert.equal(
      (await agents.list()).agents.some((a) => a.id === agentId),
      false,
    );
    // Admission: nothing refused, and a plain error is no refusal.
    assert.ok(agents.degraded() instanceof Set);
    assert.equal(agents.degraded().size, 0);
    assert.equal(agents.noteRefusal({ error: new Error("plain") }), null);
  });

  test(`${name}: agent files are written only over the expected state`, async () => {
    const { agentFiles } = await make({});
    const name = "MEMORY.md";
    assert.equal((await agentFiles.get({ agentId, name })).file.missing, true);
    await agentFiles.set({ agentId, name, content: "quartz", expectedMissing: true });
    const { file } = await agentFiles.get({ agentId, name });
    assert.equal(file.content, "quartz");
    assert.equal(file.hash, sha256("quartz"));
    // A stale expectation is refused and changes nothing.
    await assert.rejects(
      agentFiles.set({ agentId, name, content: "x", expectedHash: sha256("other") }),
    );
    await assert.rejects(
      agentFiles.set({ agentId, name, content: "x", expectedMissing: true }),
    );
    await agentFiles.set({ agentId, name, content: "slate", expectedHash: file.hash });
    assert.equal((await agentFiles.get({ agentId, name })).file.content, "slate");
    const found = await agentFiles.searchMemory({
      agentId,
      query: "slate",
      maxResults: 5,
    });
    assert.equal(found.ok, true);
    assert.ok(Array.isArray(found.output.details.results));
  });

  test(`${name}: config patches apply over the hash they read`, async () => {
    const { config } = await make({});
    const before = await config.get();
    assert.equal(typeof before.hash, "string");
    assert.equal(typeof before.config, "object");
    const watch = config.watchAdoption(quiet);
    assert.equal(typeof watch.watching, "boolean");
    watch.mark();
    const base = await config.patch({
      build: (current) => ({ patch: { cron: { enabled: !current.cron?.enabled } } }),
    });
    assert.equal(base.hash, before.hash);
    const after = await config.get();
    assert.notEqual(after.hash, before.hash);
    assert.equal(after.config.cron.enabled, !before.config.cron?.enabled);
    assert.equal(await watch.settle(base.hash, after.hash), true);
    watch.close();
    // No change, no write.
    assert.equal(await config.patch({ build: () => null }), null);
    assert.equal((await config.get()).hash, after.hash);
    // A merge patch: null removes a key.
    await config.patch({ build: () => ({ patch: { cron: null } }) });
    assert.equal((await config.get()).config.cron, undefined);
    const { reloadKind } = await config.lookup({ path: "cron.enabled" });
    assert.ok(["hot", "none", "restart"].includes(reloadKind), reloadKind);
  });

  test(`${name}: agent and config views bound to a replaced connection reach nothing`, async () => {
    const runtime = await make({});
    const connection = runtime.host.connection();
    const agents = runtime.agents.on(connection);
    const files = runtime.agentFiles.on(connection);
    const config = runtime.config.on(connection);
    assert.ok(Array.isArray((await agents.list()).agents));
    await runtime.host.restart();
    const before = await runtime.config.get();
    await assert.rejects(agents.list(), unavailable);
    await assert.rejects(
      agents.create({ name: agentId, workspace: "/w", model: "m" }),
      unavailable,
    );
    await assert.rejects(files.get({ agentId, name: "MEMORY.md" }), unavailable);
    await assert.rejects(
      config.patch({ build: () => ({ patch: { late: true } }) }),
      unavailable,
    );
    await assert.rejects(config.get(), unavailable);
    // The new connection received none of it.
    assert.equal((await runtime.config.get()).hash, before.hash);
    assert.equal(
      (await runtime.agents.list()).agents.some((a) => a.id === agentId),
      false,
    );
    const now = runtime.config.on(runtime.host.connection());
    assert.equal((await now.get()).hash, before.hash);
  });

  test(`${name}: agents, files and config reject while unreachable`, async () => {
    const { agents, agentFiles, config } = await make({ unreachable: true });
    const calls = {
      list: () => agents.list(),
      create: () => agents.create({ name: agentId, workspace: "/w", model: "m" }),
      update: () => agents.update({ agentId, name: "Ada", model: "m" }),
      delete: () => agents.delete({ agentId, deleteFiles: false }),
      waitListed: () => agents.waitListed({ agentId, timeoutMs: 1 }),
      get: () => agentFiles.get({ agentId, name: "MEMORY.md" }),
      set: () => agentFiles.set({ agentId, name: "MEMORY.md", content: "x" }),
      searchMemory: () => agentFiles.searchMemory({ agentId, query: "x", maxResults: 1 }),
      configGet: () => config.get(),
      lookup: () => config.lookup({ path: "cron.enabled" }),
      patch: () => config.patch({ build: () => ({ patch: { a: 1 } }) }),
    };
    for (const [method, call] of Object.entries(calls)) {
      // A rejection, never a synchronous throw: callers await it inside try/catch.
      const pending = call();
      assert.ok(pending instanceof Promise, method);
      await assert.rejects(pending, method);
    }
    // Nothing to wait for and nobody refused without a connection.
    await agents.settled();
    await agents.admitted();
    assert.equal(agents.degraded().size, 0);
    const refusal = { agentId, code: "agent-database-inspection-failed" };
    const error = Object.assign(new Error("refused"), { admissionRefusal: refusal });
    assert.deepEqual(agents.noteRefusal({ error }), refusal);
    const watch = config.watchAdoption(quiet);
    assert.equal(watch.watching, false);
    assert.equal(await watch.settle("a", "b"), true);
    watch.close();
  });
}

// RFC 7396: objects merge, null removes, anything else replaces.
export function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out =
    target && typeof target === "object" && !Array.isArray(target) ? target : {};
  const merged = { ...out };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

/**
 * Agents, agent files and a live configuration held in memory for the fake runtime,
 * kept across restarts as a runtime keeps them on disk. Every async call goes
 * through `reach`, which rejects while the runtime is unreachable.
 */
export function fakeAgentPorts({ reach, connection }) {
  const roster = new Map();
  const files = new Map();
  let config = {};
  let version = 0;
  const hash = () => `fake-${version}`;
  const conflict = () =>
    Object.assign(new Error("conflict"), { code: "CONFLICT", answered: true });
  const fileKey = (agentId, name) => `${agentId}/${name}`;
  const watcher = (watching) => ({
    watching,
    mark() {},
    settle: async () => true,
    close() {},
  });
  const methods = {
    agents: {
      list: () => reach(() => ({ agents: [...roster.values()].map((a) => ({ ...a })) })),
      create: ({ name, workspace, model }) =>
        reach(() => {
          roster.set(name, { id: name, name, workspace, model });
          return { agentId: name };
        }),
      update: ({ agentId, name, model }) =>
        reach(() => Object.assign(roster.get(agentId) || {}, { name, model }) && {}),
      delete: ({ agentId }) => reach(() => ({ ok: roster.delete(agentId) })),
      waitListed: ({ agentId }) =>
        reach(() => {
          if (!roster.has(agentId)) throw Object.assign(new Error("agentLoading"), {});
        }),
      settled: async () => {},
      admitted: async () => false,
      degraded: () => new Set(),
      noteRefusal: ({ error }) => error?.admissionRefusal ?? null,
    },
    agentFiles: {
      get: ({ agentId, name }) =>
        reach(() => {
          const content = files.get(fileKey(agentId, name));
          return {
            file:
              content === undefined
                ? { name, missing: true }
                : { name, content, hash: sha256(content) },
          };
        }),
      set: ({ agentId, name, content, expectedHash, expectedMissing }) =>
        reach(() => {
          const current = files.get(fileKey(agentId, name));
          if (expectedMissing === true && current !== undefined) throw conflict();
          if (expectedHash !== undefined && sha256(current ?? "") !== expectedHash)
            throw conflict();
          files.set(fileKey(agentId, name), content);
          return { file: { name, content, hash: sha256(content) } };
        }),
      searchMemory: ({ agentId, query, maxResults }) =>
        reach(() => {
          const results = [...files.entries()]
            .filter(
              ([key, text]) => key.startsWith(`${agentId}/`) && text.includes(query),
            )
            .slice(0, maxResults)
            .map(([key, text]) => ({
              path: key.slice(agentId.length + 1),
              snippet: text,
              startLine: 1,
              endLine: 1,
            }));
          return { ok: true, output: { details: { results } } };
        }),
    },
    config: {
      get: () => reach(() => ({ config: structuredClone(config), hash: hash() })),
      lookup: ({ path }) => reach(() => ({ path, reloadKind: "hot" })),
      patch: ({ build }) =>
        reach(() => {
          const base = { config: structuredClone(config), hash: hash() };
          const change = build(base.config);
          if (!change) return null;
          config = mergePatch(config, change.patch);
          version++;
          return base;
        }),
      watchAdoption: () => watcher(connection() !== null),
    },
  };
  const sync = ["degraded", "noteRefusal", "watchAdoption", "settled", "admitted"];
  const closed = () =>
    Promise.reject(
      Object.assign(new Error("closed"), { code: "UNAVAILABLE", status: 503 }),
    );
  // A view bound to one connection refuses every call once another replaced it.
  const on = (port) => (bound) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(methods[port]).map(([name, method]) => [
          name,
          sync.includes(name)
            ? method
            : (...args) => (bound && bound === connection() ? method(...args) : closed()),
        ]),
      ),
    );
  return Object.fromEntries(
    Object.keys(methods).map((port) => [port, { ...methods[port], on: on(port) }]),
  );
}
