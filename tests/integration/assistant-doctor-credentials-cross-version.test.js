import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// OpenClaw 2026.10.7's Doctor copies every plain `models.providers.*.apiKey` into its
// auth profile store, which the model request then prefers over openclaw.json. After
// an activation that ran Doctor, the key AgentPier compiles must still be the one the
// model receives, and no copy of a replaced key may stay in OpenClaw's state.
// Manual, like assistant-runtime-cross-version.test.js: it needs two installations.
const previousRoot = process.env.AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME;
const candidateRoot = process.env.AGENTPIER_ASSISTANT_UPDATE_RUNTIME;
const OLD_KEY = "doctor-old-key-5813";
const NEW_KEY = "doctor-new-key-7741";

function descriptor(root) {
  const manifest = readJSON(path.join(root, "app/node_modules/openclaw/package.json"));
  return {
    version: manifest.version,
    nodePath: path.join(root, "node/bin/node"),
    entryPath: path.join(root, "app/node_modules/openclaw/openclaw.mjs"),
  };
}

// A model that answers only the key it currently accepts, as a provider does after
// the owner rotated or revoked the old one, and records the key of every request.
async function keyedModel() {
  const seen = [];
  let accepted = OLD_KEY;
  const server = http.createServer(async (req, res) => {
    let bytes = "";
    for await (const part of req) bytes += part;
    if (!bytes) return res.writeHead(404).end();
    const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
    seen.push(key);
    if (key !== accepted) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [{ content: "A useful assistant reply." }, null],
      [{}, "stop"],
    ])
      res.write(
        `data: ${JSON.stringify({ id: "doctor-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    accept: (key) => (accepted = key),
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

// Every OpenClaw SQLite database of the runtime state that holds `secret` in a row.
function databasesHolding(paths, secret) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.sqlite$/.test(entry.name)) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all();
          for (const { name } of tables) {
            const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
            if (
              JSON.stringify(rows, (k, v) =>
                v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v,
              ).includes(secret)
            )
              hits.push(`${path.relative(paths.root, file)}:${name}`);
          }
        } finally {
          db.close();
        }
      }
    }
  };
  walk(paths.state);
  return hits;
}

test(
  "native cross-version activation keeps openclaw.json's model key authoritative",
  { skip: !previousRoot || !candidateRoot, timeout: 240000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-doctor-keys-"));
    const previous = descriptor(previousRoot),
      candidate = descriptor(candidateRoot);
    assert.notEqual(previous.version, candidate.version);
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db);
    const model = await keyedModel();
    let runtime;
    try {
      runtime = new RuntimeSupervisor({
        dataDir,
        install: async () => readJSON(path.join(runtime.paths.root, "runtime.json")),
      });
      writePrivate(path.join(runtime.paths.root, "runtime.json"), previous);
      const a = store.createAssistant({
        name: "Doctor key fixture",
        model: { connectionId: "fixture", modelId: "fixture-model" },
        capabilities: { memory: true, reminders: true },
      });
      const assistants = {
        store,
        ledger,
        runtime,
        locks: new Map(),
        maintenance: false,
        changed() {},
        admit: (fn) => Promise.resolve().then(fn),
        requireReady() {
          assert.ok(runtime.client?.ready);
        },
        reconcile: async () => {},
      };
      runtime.maintenance = () => assistants.maintenance;
      runtime.teamConfiguration = async (installed) => ({
        directory: provisionTeamPlugin({
          paths: runtime.paths,
          runtimeVersion: installed.version,
        }).directory,
        connection: { url: "http://127.0.0.1:1", token: "fixture" },
        native: { token: "fixture-webhook" },
        hostMaxConcurrent: 4,
        profiles: store.listAssistants(),
      });
      await runtime.start();
      // A provider whose id stays the same when its key changes, as the Telegram
      // voice provider `deepgram` does; model connections also get a new id.
      let apiKey = OLD_KEY;
      assistants.config = new AssistantConfig({
        client: { call: (...args) => runtime.client.call(...args) },
        store,
        workspaces: runtime.paths.workspaces,
        models: {
          resolve: () => ({
            providerId: "fixture",
            modelRef: "fixture/fixture-model",
            provider: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey,
              models: [
                {
                  id: "fixture-model",
                  name: "Fixture",
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
            release() {},
          }),
        },
      });
      assistants.config.nativeReady = () => true;
      await assistants.config.apply(a.id);
      const chat = await createGatewaySession(runtime.client, {
        agentId: a.runtimeAgentId,
      });
      const turn = async (text) => {
        const sent = await runtime.client.call("sessions.send", {
          key: chat.key,
          message: text,
          idempotencyKey: `doctor-keys-${text}`,
        });
        return runtime.client.call(
          "agent.wait",
          { runId: sent.runId, timeoutMs: 45000 },
          { timeoutMs: 50000 },
        );
      };
      assert.equal((await turn("before-update")).status, "ok");
      assert.equal(model.seen.at(-1), OLD_KEY);

      const services = {
        assistants,
        assistantRuntime: runtime,
        assistantChannels: {
          pause: async () => {},
          resume() {},
          store: { list: () => [] },
        },
        assistantReminders: {
          webhook: { jobs: new Set() },
          hasRunning: async () => false,
        },
      };
      const updates = new RuntimeUpdates({
        dataDir,
        runtime,
        maintenance: new AssistantMaintenance(services),
        stage: async () => candidate,
      });
      await updates.stage();
      await updates.activate();
      assert.equal(runtime.status().version, candidate.version);
      // Doctor's copy of the compiled key is gone with the activation; openclaw.json
      // keeps it.
      assert.deepEqual(databasesHolding(runtime.paths, OLD_KEY), []);
      assert.equal((await turn("after-update")).status, "ok");
      assert.equal(model.seen.at(-1), OLD_KEY);

      // The owner rotates the key and the provider revokes the old one.
      apiKey = NEW_KEY;
      model.accept(NEW_KEY);
      await assistants.config.apply(a.id);
      const before = model.seen.length;
      const rotated = await turn("after-rotation");
      assert.ok(model.seen.length > before, "the rotated turn reached the model");
      assert.deepEqual(
        [...new Set(model.seen.slice(before))],
        [NEW_KEY],
        "every request after the rotation carries the new key",
      );
      assert.equal(rotated.status, "ok");
      // A restart keeps the rotated key and resurrects no copy of the old one. The
      // updated runtime itself copies no configured key into its state either.
      await runtime.restart();
      assert.deepEqual(databasesHolding(runtime.paths, OLD_KEY), []);
      assert.deepEqual(databasesHolding(runtime.paths, NEW_KEY), []);
      assert.equal(
        readJSON(runtime.paths.config).models.providers.fixture.apiKey,
        NEW_KEY,
      );
      // Removing the connection removes its provider from openclaw.json, the only
      // place the key then lives: no turn can send it and no state keeps it.
      await runtime.stop();
      const config = readJSON(runtime.paths.config);
      delete config.models.providers.fixture;
      writePrivate(runtime.paths.config, config);
      await runtime.start();
      const removed = model.seen.length;
      const blocked = await turn("after-removal").catch((error) => error);
      assert.ok(
        blocked instanceof Error || blocked.status !== "ok",
        "no turn without a key",
      );
      assert.equal(model.seen.length, removed, "no request after the removal");
      assert.deepEqual(databasesHolding(runtime.paths, NEW_KEY), []);
    } finally {
      await runtime?.close();
      store.close();
      await model.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
