import fs from "node:fs";
import path from "node:path";
import { teamFixture } from "./assistant-team-fixture.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { ReminderBindings } from "../../server/features/assistants/reminder-bindings.js";
import { HookStore } from "../../server/features/assistants/agent-hook-store.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { AgentLifecycle } from "../../server/features/assistants/agent-lifecycle.js";

const model = { connectionId: "c", modelId: "m" };

/**
 * The team fixture with what archive and delete reach (agent-lifecycle.js): runtime
 * folders, reminder bindings with native cron jobs, hooks, actions, a Telegram
 * channel, MCP bindings and an audit log that checks every event against the schema.
 */
export function lifecycleFixture(t) {
  const f = teamFixture(t);
  const root = path.join(f.dataDir, "assistants");
  const paths = { root, state: path.join(root, "state") };
  paths.workspaces = path.join(root, "workspaces");
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  f.assistants.runtime.paths = paths;
  const cron = [],
    removedJobs = [],
    deletedAgents = [],
    audit = [],
    forgotten = [],
    unbound = [],
    disabled = [],
    synced = [];
  // The Gateway's roster: what agents.delete removes, with the agent's cron jobs
  // (OpenClaw 2026.10.7 agents.delete, agent-deletion-contract.test.js).
  const roster = new Set();
  const call = f.assistants.runtime.client.call.bind(f.assistants.runtime.client);
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "agents.list")
      return { agents: [...new Set([...roster, ...f.profiles])].map((id) => ({ id })) };
    if (method === "agents.delete") {
      deletedAgents.push(input);
      roster.delete(input.agentId);
      f.profiles.delete(input.agentId);
      for (const job of cron.filter((j) => j.agentId === input.agentId)) {
        removedJobs.push(job.id);
        cron.splice(cron.indexOf(job), 1);
      }
      return { ok: true };
    }
    return call(method, input);
  };
  const bindings = new ReminderBindings(f.store.db);
  f.assistants.reminders = {
    bindings,
    async disable(id) {
      disabled.push(id);
    },
    async jobs(agent) {
      return cron.filter((j) => j.agentId === agent.runtimeAgentId);
    },
    heartbeats: {
      async sync(id) {
        synced.push([id, !!f.store.storedAssistant(id).archivedAt]);
      },
    },
    async close() {},
  };
  const hooks = new HookStore(f.store.db);
  const actions = new AssistantActionStore(f.store.db);
  f.store.db.exec(
    "CREATE TABLE IF NOT EXISTS assistant_access(assistant_id TEXT PRIMARY KEY REFERENCES assistants(id),body TEXT NOT NULL)",
  );
  const channels = {
    list: [],
    store: { list: () => channels.list },
    async forget(id) {
      forgotten.push(id);
      channels.list = channels.list.filter((c) => c.id !== id);
    },
  };
  const mcpServers = {
    setBindings(kind, id, list) {
      unbound.push([kind, id, list]);
    },
  };
  f.assistants.browsers = {
    stopped: [],
    async stopAgent(id) {
      this.stopped.push(id);
    },
    isRunning: () => false,
    async close() {},
  };
  f.assistants.telegramSenders = { connected: () => false };
  f.assistants.config.applying = () => false;
  const services = {
    assistants: f.assistants,
    teams: f.service,
    channels,
    mcpServers,
    paths,
    dataDir: f.dataDir,
    audit: { append: (event) => audit.push(auditEvent(event)) },
  };
  const lifecycle = new AgentLifecycle(services);
  f.assistants.lifecycle = lifecycle;

  /** An agent with something in every store that a delete cleans. */
  function populated(name = "Helper", origin = null) {
    const agent = f.store.createAssistant({ name, instructions: "Help", model }, origin);
    const chat = f.store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: `chat-${agent.id}`,
      main: true,
    });
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text: "Private text",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    f.assistants.ledger.transition(attempt.id, "completed");
    f.store.cacheMessages(chat.id, [{ role: "user", text: "Private text" }]);
    const { binding } = bindings.reserve(
      agent.id,
      "daily",
      "owner",
      { at: 1 },
      {
        kind: "routine",
      },
    );
    bindings.patch(binding.id, { state: "bound" });
    cron.push({ id: `job-${agent.id}`, agentId: agent.runtimeAgentId });
    // A job the agent created itself, never bound in AgentPier.
    cron.push({ id: `own-${agent.id}`, agentId: agent.runtimeAgentId });
    hooks.create({ assistantId: agent.id, name: "Deploys" });
    actions.db
      .prepare("INSERT INTO assistant_actions VALUES(?,?,?,?)")
      .run(
        `action-${agent.id}`,
        agent.id,
        `op-${agent.id}`,
        JSON.stringify({ id: `action-${agent.id}`, state: "awaiting_approval" }),
      );
    f.store.db
      .prepare("INSERT INTO assistant_access VALUES(?,?)")
      .run(agent.id, JSON.stringify({ projectIds: ["p1"] }));
    channels.list.push({ id: `channel-${agent.id}`, assistantId: agent.id });
    const workspace = path.join(paths.workspaces, agent.id);
    fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "Notes");
    fs.writeFileSync(path.join(workspace, "memory", "2026-10-27.md"), "Day");
    fs.writeFileSync(path.join(workspace, "plan.txt"), "Plan");
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Managed");
    const state = path.join(paths.state, "agents", agent.runtimeAgentId, "sessions");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "s.jsonl"), "{}");
    const profile = path.join(paths.state, "browser", `agent-${agent.id}`);
    fs.mkdirSync(profile, { recursive: true });
    roster.add(agent.runtimeAgentId);
    return { agent: f.store.getAssistant(agent.id), chat, request, attempt, workspace };
  }
  return {
    ...f,
    paths,
    services,
    lifecycle,
    bindings,
    hooks,
    actions,
    channels,
    cron,
    removedJobs,
    deletedAgents,
    roster,
    audit,
    forgotten,
    unbound,
    disabled,
    synced,
    populated,
    model,
  };
}
