import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { ExecApprovals } from "../../server/features/assistants/exec-approvals.js";

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const gatewayError = (code, remoteMessage) =>
  Object.assign(Error(code), { code, answered: true, remoteMessage });
export const staleHash = () =>
  gatewayError(
    "INVALID_REQUEST",
    "exec approvals changed since last load; re-run exec.approvals.get and retry",
  );

// A workflow fixture whose Gateway is a recording fake: `answers[method]` is a
// value, an error or a function of the params.
export async function execFixture(t) {
  const f = await workflowFixture(t);
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(f.id, { shell: "approval" }, agent.revision);
  const emitter = new EventEmitter();
  const client = {
    ready: true,
    calls: [],
    answers: { "exec.approval.list": [] },
    async call(method, params) {
      this.calls.push({ method, params });
      const answer = this.answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : answer;
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
  f.assistants.runtime.client = client;
  f.assistants.gatewayEvents = new GatewayEventHub();
  f.assistants.gatewayEvents.bind(client);
  // ExecApprovals registers on the hub it finds at construction.
  f.workflows.exec.close();
  f.workflows.exec = new ExecApprovals(f.workflows, { log: () => {} });
  const audit = [];
  f.services.audit = { append: (entry) => audit.push(entry) };
  const emit = (event, payload) => emitter.emit("event", { event, payload });
  const resolves = () =>
    client.calls.filter((c) => c.method === "exec.approval.resolve").map((c) => c.params);
  const telegram = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  };
  async function request(id, overrides = {}, origin = { kind: "owner" }) {
    const inv = await f.invocation(`turn-${id}`, origin);
    emit("exec.approval.requested", {
      id,
      request: {
        command: "git status",
        cwd: "/work",
        agentId: agent.runtimeAgentId,
        sessionKey: "session",
        runId: inv.attemptId,
        resolvedPath: "/usr/bin/git",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        ...overrides,
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 1800000,
    });
    await settle();
    return f.workflows.list(f.id).actions.find((a) => a.payload.approvalId === id);
  }
  const decisions = () =>
    audit
      .filter((e) => e.action === "assistant.answered")
      .map(({ outcome, details }) => ({ outcome, ...details }));
  // An owner-writable program in the fixture's directory, by its real path.
  const program = (name) => {
    const dir = path.join(f.dataDir, "owner-bin");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    return fs.realpathSync(file);
  };
  return {
    ...f,
    agent,
    program,
    gateway: client,
    emit,
    audit,
    decisions,
    resolves,
    request,
    telegram,
  };
}
