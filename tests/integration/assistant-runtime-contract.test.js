import { qualifyAssistantChannels } from "../helpers/assistant-channel-contract.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
const dataDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
// Five Gateway starts (initial, crash, recovery, stop/start): a passing hosted
// macOS run already took 89 s, and the same runner type is often 30 % slower.
test(
  "pinned Gateway applies profiles and streams a real model tool loop",
  { skip: !dataDir, timeout: 300000 },
  async (t) => {
    assert.ok(
      path.isAbsolute(dataDir) &&
        (dataDir.includes("assistant-qualification") ||
          process.env.AGENTPIER_ASSISTANT_QUALIFICATION === "1"),
      "requires dedicated disposable qualification data",
    );
    const model = await assistantModelServer();
    t.after(() => model.close());
    const runtime = new RuntimeSupervisor({ dataDir });
    // CI only reports the failing assertion or a bare timeout; keep enough evidence
    // to tell a slow host from a failed native run.
    const started = Date.now();
    const evidence = { phases: [], statuses: [], events: [] };
    const step = (name) => evidence.phases.push([name, Date.now() - started]);
    const keep = (list, entry) => list.push(entry) > 30 && list.shift();
    let finished = false;
    runtime.on("status", (s) =>
      keep(evidence.statuses, [s.availability, s.diagnostic, Date.now() - started]),
    );
    const createClient = runtime.clientFactory;
    runtime.clientFactory = (options) => {
      const client = createClient(options);
      client.subscribe((e) =>
        keep(evidence.events, [
          e.event,
          e.payload?.state ?? e.payload?.stream ?? e.payload?.data?.phase,
          e.payload?.runId,
          Date.now() - started,
        ]),
      );
      return client;
    };
    let service;
    const tail = (name) => {
      try {
        return fs
          .readFileSync(path.join(runtime.paths.logs, name), "utf8")
          .slice(-3000)
          .split("\n")
          .slice(1);
      } catch (error) {
        return error.code;
      }
    };
    t.after(() => {
      if (finished && !process.env.CONTRACT_EVIDENCE) return;
      console.log(
        `CONTRACT_EVIDENCE ${JSON.stringify({
          ...evidence,
          elapsedMs: Date.now() - started,
          modelRequests: model.requests.length,
          attempts: service?.ledger.pending().map((a) => [a.id, a.state]),
          console: tail("gateway-console.log"),
        })}`,
      );
    });

    const store = new AssistantStore({ dataDir });
    t.after(async () => {
      if (service) await service.close();
      else {
        await runtime.close();
        store.close();
      }
    });
    await runtime.start();
    step("start");
    const models = {
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
    };
    const config = new AssistantConfig({
      client: runtime.client,
      models,
      store,
      workspaces: runtime.paths.workspaces,
    });
    const a = store.createAssistant({
      name: "Contract",
      instructions: "Answer briefly.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    await config.apply(a.id);
    assert.equal(store.getAssistant(a.id).effectiveRevision, 1);
    step("applied");
    const chat = await runtime.client.call("sessions.create", {
      agentId: a.runtimeAgentId,
      label: "Contract",
    });
    const sent = await runtime.client.call("sessions.send", {
      key: chat.key,
      message: "Check your status, then reply.",
      idempotencyKey: crypto.randomUUID(),
    });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.equal(done.status, "ok");
    assert.ok(done.terminalReceipt?.successfulToolNames.includes("session_status"));
    const history = await runtime.client.call("chat.history", {
      sessionKey: chat.key,
      limit: 50,
    });
    assert.ok(JSON.stringify(history).includes("A useful assistant reply."));
    assert.ok(model.requests.length >= 2, "tool result drives a second model turn");
    // A missing explicitly selected native profile must not fall back to the
    // working provider key. This also exercises keyless async configuration.
    step("direct-run");
    const workingResolve = models.resolve;
    const beforeMissingProfile = model.requests.length;
    models.resolve = async () => ({
      modelRef: "fixture/fixture-model@fixture:missing-account",
      release() {},
    });
    await config.apply(a.id);
    const missingChat = await runtime.client.call("sessions.create", {
      agentId: a.runtimeAgentId,
      label: "Missing explicit account",
    });
    const missingSend = await runtime.client.call("sessions.send", {
      key: missingChat.key,
      message: "This must not reach the model.",
      idempotencyKey: crypto.randomUUID(),
    });
    const missingResult = await runtime.client.call("agent.wait", {
      runId: missingSend.runId,
      timeoutMs: 5000,
    });
    assert.equal(missingResult.status, "error");
    assert.equal(model.requests.length, beforeMissingProfile);
    step("missing-profile-run");
    models.resolve = workingResolve;
    await config.apply(a.id);
    service = new AssistantService({
      store,
      models: { ...models, listCapabilities: () => [] },
      runtime,
      config,
    });
    step("reapplied");
    const conversation = await service.openConversation(a.id);
    const delivered = await service.send(conversation.id, {
      clientRequestId: "service-contract",
      text: "Check your status again.",
    });
    for (
      let n = 0;
      n < 100 &&
      !["completed", "failed", "cancelled"].includes(
        service.ledger.getAttempt(delivered.attempt.id).state,
      );
      n++
    ) {
      await delay(100);
      await service.reconcile();
    }
    const outcome = service.ledger.getAttempt(delivered.attempt.id).state;
    if (outcome !== "completed") {
      // Keep the native evidence: CI otherwise only shows the ledger state.
      const native = await runtime.client
        .call("agent.wait", { runId: delivered.attempt.id, timeoutMs: 1 })
        .catch((error) => ({ code: error.code }));
      assert.fail(
        `Service attempt ${outcome}: ${JSON.stringify({
          status: native.status,
          code: native.code,
          error: native.error,
          stopReason: native.stopReason,
          modelRequests: model.requests.length,
        })}`,
      );
    }
    step("service-run");
    const repeated = await service.send(conversation.id, {
      clientRequestId: "service-contract",
      text: "Check your status again.",
    });
    assert.equal(repeated.request.id, delivered.request.id);
    assert.ok(
      (await service.history(conversation.id)).messages.some(
        (m) => m.text === "A useful assistant reply.",
      ),
    );
    step("service-history");
    await qualifyAssistantChannels({ dataDir, assistants: service, assistantId: a.id });
    step("channels");
    const crashed = await service.send(conversation.id, {
      clientRequestId: "crash-contract",
      text: "HOLD_FOR_CRASH",
    });
    for (
      let n = 0;
      n < 100 &&
      !model.requests.some((r) => JSON.stringify(r).includes("HOLD_FOR_CRASH"));
      n++
    )
      await delay(100);
    assert.ok(model.requests.some((r) => JSON.stringify(r).includes("HOLD_FOR_CRASH")));
    step("crash-held");
    const countBeforeCrash = model.requests.length;
    const oldPid = runtime.child.pid;
    runtime.child.kill("SIGKILL");
    // The supervisor's own readiness budget bounds the crash restart.
    const restartDeadline = Date.now() + 150000;
    while (
      Date.now() < restartDeadline &&
      (runtime.child?.pid === oldPid || !runtime.client?.ready)
    )
      await delay(100);
    assert.ok(runtime.client?.ready);
    assert.notEqual(runtime.child.pid, oldPid);
    step("crash-restarted");
    await service.reconcile();
    assert.ok(
      ["interrupted", "uncertain"].includes(
        service.ledger.getAttempt(crashed.attempt.id).state,
      ),
    );
    assert.equal(model.requests.length, countBeforeCrash, "crashed work is not replayed");
    await service.recover(crashed.attempt.id, { acknowledgeUnknownOutcome: true });
    assert.ok(service.ledger.getAttempt(crashed.attempt.id).reviewedAt);
    assert.equal(model.requests.length, countBeforeCrash);
    step("recovered");
    clearInterval(service.poll);
    service.unsubscribe?.();
    runtime.off("status", service.onStatus);
    await runtime.stop();
    await runtime.start();
    assert.ok(
      JSON.stringify(
        await runtime.client.call("chat.history", { sessionKey: chat.key, limit: 50 }),
      ).includes("A useful assistant reply."),
    );
    finished = true;
  },
);
