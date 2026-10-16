import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// One agent conversation on a scripted Gateway: `finish(runId, status)` ends a run.
export function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-queued-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces);
  const sent = [];
  const runs = new Map();
  const services = [];
  const start = () => {
    const store = new AssistantStore({ dataDir });
    const client = new EventEmitter();
    client.ready = true;
    client.subscribe = () => () => {};
    client.call = async (method, params) => {
      if (method === "sessions.send") {
        sent.push(params);
        return { runId: params.idempotencyKey };
      }
      if (method === "sessions.abort") {
        runs.set(params.runId, { status: "aborted" });
        return {};
      }
      if (method === "agent.wait")
        return runs.get(params.runId)
          ? { ...runs.get(params.runId), runId: params.runId }
          : { status: "timeout" };
      if (method === "chat.history") return { messages: [], hasMore: false };
      if (method === "sessions.messages.subscribe") return {};
      if (method === "sessions.describe") return { session: {} };
      assert.fail(method);
    };
    const runtime = new EventEmitter();
    runtime.client = client;
    runtime.close = async () => {};
    runtime.setState = () => {};
    const service = new AssistantService({
      store,
      runtime,
      models: {
        listCapabilities: () => [],
        resolve: () => ({ release() {} }),
        imageInput: () => true,
      },
      config: { apply: async () => {}, reset() {}, workspaces },
    });
    services.push(service);
    return { service, store, client };
  };
  t.after(async () => {
    for (const service of services) if (!service.closed) await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const first = start();
  const a = first.store.createAssistant({
    name: "lead",
    model: { connectionId: "c", modelId: "m" },
  });
  const c = first.store.saveConversation({
    assistantId: a.id,
    runtimeSessionKey: "lead",
  });
  const finish = async (service, status = "ok", extra = {}) => {
    runs.set(sent.at(-1).idempotencyKey, { status, ...extra });
    await service.reconcile();
    // The dispatch runs after the reconcile pass; let it reach sessions.send.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { ...first, start, c, sent, finish };
}

export const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
