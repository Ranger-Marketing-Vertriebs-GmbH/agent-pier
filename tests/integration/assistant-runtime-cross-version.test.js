import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { assistantRoutineModel } from "../helpers/assistant-routine-model.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

const previousRoot = process.env.AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME;
const candidateRoot = process.env.AGENTPIER_ASSISTANT_UPDATE_RUNTIME;
function descriptor(root) {
  const manifest = readJSON(path.join(root, "app/node_modules/openclaw/package.json"));
  return {
    version: manifest.version,
    nodePath: path.join(root, "node/bin/node"),
    entryPath: path.join(root, "app/node_modules/openclaw/openclaw.mjs"),
  };
}
const variants = {
  upgrade: "activation retains memory, schedules, history and receipts",
  reject: "validation failure restores previous runtime and state",
  legacyRoster: "activation canonicalizes a legacy agents.list roster",
};
for (const [variant, title] of Object.entries(variants))
  test(
    `native cross-version ${title}`,
    { skip: !previousRoot || !candidateRoot, timeout: 180000 },
    async () => {
      const rejectCandidate = variant === "reject";
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "assistant-version-contract-"),
      );
      const previous = descriptor(previousRoot),
        candidate = descriptor(candidateRoot);
      assert.notEqual(
        previous.version,
        candidate.version,
        "requires two actual package versions",
      );
      const store = new AssistantStore({ dataDir }),
        ledger = new RequestLedger(store.db);
      const model = await assistantRoutineModel();
      let runtime;
      try {
        runtime = new RuntimeSupervisor({
          dataDir,
          install: async () => readJSON(path.join(runtime.paths.root, "runtime.json")),
        });
        const selection = path.join(runtime.paths.root, "runtime.json");
        writePrivate(selection, previous);
        const a = store.createAssistant({
          name: "Version fixture",
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
                apiKey: "fixture-key",
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
        const memory = new NativeMemory(assistants),
          note = await memory.read(a.id, "MEMORY.md");
        await memory.write(a.id, {
          name: "MEMORY.md",
          content: "CROSS_VERSION_NOTE_4729",
          ...(note.missing ? { expectedMissing: true } : { expectedHash: note.hash }),
        });
        const chat = await createGatewaySession(runtime.client, {
          agentId: a.runtimeAgentId,
        });
        const conversation = store.saveConversation({
          assistantId: a.id,
          runtimeSessionKey: chat.key,
        });
        const input = {
          clientRequestId: "cross-version-turn",
          text: "CROSS_VERSION_HISTORY_4729",
        };
        const request = ledger.accept(conversation.id, input),
          attempt = ledger.recordAttempt(request.id);
        const sent = await runtime.client.call("sessions.send", {
          key: chat.key,
          message: input.text,
          idempotencyKey: attempt.id,
        });
        const result = await runtime.client.call(
          "agent.wait",
          { runId: sent.runId, timeoutMs: 45000 },
          { timeoutMs: 50000 },
        );
        assert.equal(result.status, "ok");
        ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
        ledger.transition(attempt.id, "completed");
        const job = await runtime.client.call("cron.add", {
          name: "Version schedule",
          enabled: false,
          deleteAfterRun: false,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "CROSS_VERSION_SCHEDULE" },
        });
        if (variant === "legacyRoster") {
          // An older install persisted the roster as an `agents.list` array with a
          // `default` marker and without explicit ownership.
          await runtime.stop();
          const c = readJSON(runtime.paths.config);
          c.agents.list = Object.entries(c.agents.entries).map(([id, e]) => ({
            id,
            ...e,
            ...(id === "main" && { default: true }),
          }));
          delete c.agents.entries;
          delete c.agents.ownership;
          delete c.agents.defaults?.systemAgent;
          delete c.talk;
          writePrivate(runtime.paths.config, c);
          await runtime.start();
        }
        const callsBefore = model.requests.length;
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
        const maintenance = new AssistantMaintenance(services),
          validate = maintenance.validate.bind(maintenance);
        let candidateObserved = false;
        maintenance.validate = async () => {
          await validate();
          if (runtime.status().version === candidate.version) {
            candidateObserved = true;
            if (rejectCandidate) {
              const current = await runtime.client.call("agents.files.get", {
                agentId: a.runtimeAgentId,
                name: "MEMORY.md",
              });
              await runtime.client.call("agents.files.set", {
                agentId: a.runtimeAgentId,
                name: "MEMORY.md",
                content: "CANDIDATE_MUTATION",
                expectedHash: current.file.hash,
              });
              throw Error("Injected candidate validation failure");
            }
          }
        };
        const updates = new RuntimeUpdates({
          dataDir,
          runtime,
          maintenance,
          stage: async () => candidate,
        });
        await updates.stage();
        assert.equal(runtime.status().version, previous.version);
        if (rejectCandidate)
          await assert.rejects(updates.activate(), { code: "UPDATE_ROLLED_BACK" });
        else await updates.activate();
        assert.equal(candidateObserved, true);
        assert.equal(
          updates.status().phase,
          rejectCandidate ? "rolled_back" : "complete",
        );
        const expected = rejectCandidate ? previous : candidate;
        assert.equal(runtime.status().version, expected.version);
        assert.equal(readJSON(selection).version, expected.version);
        assert.equal(assistants.maintenance, false);
        await runtime.restart();
        assert.equal(runtime.status().version, expected.version);
        const restored = await runtime.client.call("agents.files.get", {
          agentId: a.runtimeAgentId,
          name: "MEMORY.md",
        });
        assert.equal(restored.file.content, "CROSS_VERSION_NOTE_4729");
        const jobs = await runtime.client.call("cron.list", {
          includeDisabled: true,
          limit: 200,
        });
        const retained = jobs.jobs.find((j) => j.id === job.id);
        assert.equal(retained.enabled, false);
        assert.equal(retained.schedule.tz, "Europe/Berlin");
        const history = await runtime.client.call("chat.history", {
          sessionKey: chat.key,
          limit: 50,
        });
        assert.ok(JSON.stringify(history.messages).includes(input.text));
        assert.ok(JSON.stringify(history.messages).includes("A useful assistant reply."));
        assert.equal(ledger.getAttempt(attempt.id).state, "completed");
        assert.equal(ledger.requests(conversation.id).length, 1);
        assert.equal(
          model.requests.length,
          callsBefore,
          "upgrade, rollback and restart must not replay model turns",
        );
        if (variant === "legacyRoster") {
          const config = readJSON(runtime.paths.config);
          assert.equal(config.agents.list, undefined);
          for (const id of ["main", a.runtimeAgentId]) {
            assert.ok(config.agents.entries[id], `roster keeps ${id}`);
            assert.equal(config.agents.entries[id].default, undefined);
          }
          assert.equal(config.agents.ownership, "explicit");
          assert.equal(config.agents.defaults.systemAgent.agentId, "main");
          assert.equal(config.talk.agentId, "main");
          const listed = await runtime.client.call("agents.list", {});
          const ids = (listed.agents || []).map((agent) => agent.id);
          assert.ok(ids.includes("main"), `agents.list returns main: ${ids}`);
          assert.ok(ids.includes(a.runtimeAgentId), `agents.list returns ${ids}`);
        }
      } finally {
        await runtime?.close();
        store.close();
        await model.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
