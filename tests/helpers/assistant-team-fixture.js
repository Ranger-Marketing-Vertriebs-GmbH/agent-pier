import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
export function teamFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-execution-"));
  const store = new AssistantStore({ dataDir }),
    calls = [],
    sessions = [],
    profiles = new Set(),
    runs = new Map();
  let loseSession = false,
    loseProfile = false,
    loseSend = false,
    loadingCatalog = 0,
    refusingStorage = 0,
    now = 0;
  const runtime = Object.assign(new EventEmitter(), {
    generation: 1,
    setState() {},
    async close() {},
    async stop() {},
    async start() {},
  });
  runtime.client = {
    ready: true,
    subscribe: () => () => {},
    async call(method, input) {
      calls.push({ method, input });
      if (method === "agents.list")
        return { agents: [...profiles].map((id) => ({ id })) };
      if (method === "sessions.list") return { sessions };
      if (method === "sessions.create") {
        // As OpenClaw 2026.10.3 after its bounded model-catalog wait: no session.
        if (loadingCatalog > 0) {
          loadingCatalog--;
          throw Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
            code: "UNAVAILABLE",
            status: 503,
            answered: true,
            retryable: true,
          });
        }
        // As OpenClaw before a new session's storage is ready: no session.
        if (refusingStorage > 0) {
          refusingStorage--;
          throw Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
            code: "UNAVAILABLE",
            status: 503,
            answered: true,
            remoteError: "SessionMutationFactsUnavailableError",
          });
        }
        const s = {
          key: `session-${sessions.length}`,
          agentId: input.agentId,
          label: input.label,
        };
        sessions.push(s);
        if (loseSession) {
          loseSession = false;
          throw Error("Lost session acknowledgement");
        }
        return s;
      }
      if (method === "sessions.send") {
        runs.set(input.idempotencyKey, { key: input.key, status: "pending" });
        if (loseSend) {
          loseSend = false;
          throw Error("Lost send acknowledgement");
        }
        return { runId: input.idempotencyKey };
      }
      if (method === "agent.wait") return runs.get(input.runId) || { status: "timeout" };
      if (method === "sessions.describe") return { session: {} };
      if (method === "sessions.abort" || method === "sessions.messages.subscribe")
        return {};
      if (method === "chat.history")
        return {
          messages: [...runs]
            .filter(([, r]) => r.key === input.sessionKey && r.status === "ok")
            .map(([id]) => ({
              role: "assistant",
              content: "Result from member",
              __openclaw: { id, runId: id },
            })),
        };
      throw Error(method);
    },
  };
  const config = {
    async apply(id) {
      profiles.add(store.getAssistant(id).runtimeAgentId);
      if (loseProfile) {
        loseProfile = false;
        throw Error("Lost profile acknowledgement");
      }
    },
    reset() {},
  };
  const models = { resolve: async () => ({ release() {} }), listCapabilities: () => [] };
  const assistants = new AssistantService({ store, runtime, config, models });
  clearInterval(assistants.poll);
  const service = new TeamService({
    assistants,
    config,
    autoStart: false,
    now: () => now,
  });
  assistants.teams = service;
  t.after(async () => {
    await service.close();
    await assistants.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  // `context` is the trusted context of the parent's turn (an owner turn by default).
  async function proposal({
    count = 4,
    allowed = true,
    parent,
    members,
    context = { kind: "owner" },
  } = {}) {
    parent ||= store.createAssistant({
      name: "Parent",
      instructions: "Original",
      model: { connectionId: "c", modelId: "m" },
    });
    const chat = store.saveConversation({
      assistantId: parent.id,
      runtimeSessionKey: `parent-${parent.id}`,
    });
    const request = assistants.ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text: "Team",
    });
    service.store.recordContext(request.id, { ...context, teamAllowed: allowed });
    const attempt = assistants.ledger.recordAttempt(request.id);
    const result = await service.propose(
      { attemptId: attempt.id, toolCallId: "call", assertCurrent() {} },
      {
        objective: "Review",
        members:
          members ||
          Array.from({ length: count }, (_, n) => ({
            name: `Member ${n}`,
            role: "Review",
            assignment: `Review area ${n}`,
          })),
      },
    );
    return { team: service.store.get(result.id), parent, chat, attempt };
  }
  return {
    store,
    assistants,
    service,
    calls,
    sessions,
    profiles,
    runs,
    proposal,
    clock: (value) => (now = value),
    loseSession: () => (loseSession = true),
    loseProfile: () => (loseProfile = true),
    loseSend: () => (loseSend = true),
    loadCatalog: (answers) => (loadingCatalog = answers),
    refuseStorage: (answers) => (refusingStorage = answers),
    complete(id, status = "ok") {
      const r = runs.get(id);
      runs.set(id, { ...r, status });
      assistants.ledger.transition(id, status === "ok" ? "completed" : "failed");
    },
  };
}
