import fs from "node:fs";
import path from "node:path";
import { teamFixture } from "./assistant-team-fixture.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { ReminderBindings } from "../../server/features/assistants/reminder-bindings.js";
import { HookStore } from "../../server/features/assistants/agent-hook-store.js";
import { HookEvents } from "../../server/features/assistants/agent-hook-events.js";
import { RoutineResults } from "../../server/features/assistants/routine-results.js";
import { RoutineEvents } from "../../server/features/assistants/routine-events.js";
import { dismissalTable } from "../../server/features/assistants/long-chats.js";
import { LeadShares } from "../../server/features/assistants/lead-shares.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { AgentLifecycle } from "../../server/features/assistants/agent-lifecycle.js";
import { AgentSessionStore } from "../../server/features/assistants/coding-sessions/session-store.js";
import { ChannelStore } from "../../server/features/assistant-channels/channel-store.js";
import { TelegramFollowUps } from "../../server/features/assistant-channels/telegram-follow-ups.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";

const model = { connectionId: "c", modelId: "m" };

/**
 * The team fixture with what archive and delete reach (agent-lifecycle.js), on the
 * real schemas: runtime folders, reminder bindings with native cron jobs, hooks and
 * their events, routine results and events, memory notes, long-chat tables, lead
 * shares, actions, access, Telegram channels with follow-ups (channels.sqlite), MCP
 * bindings, project memory and pipeline runs that stay, and an audit log that checks
 * every event against the schema. `fail` injects Gateway and step failures.
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
    updatedJobs = [],
    audit = [],
    forgotten = [],
    unbound = [],
    disabled = [],
    synced = [];
  const fail = {
    agentsDelete: 0,
    forget: new Set(),
    cronUpdate: new Set(),
    jobs: new Set(),
  };
  // The Gateway's roster: what agents.delete removes, with the agent's cron jobs
  // (OpenClaw 2026.10.7 agents.delete, agent-deletion-contract.test.js).
  const roster = new Set();
  const call = f.assistants.runtime.client.call.bind(f.assistants.runtime.client);
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "agents.list")
      return { agents: [...new Set([...roster, ...f.profiles])].map((id) => ({ id })) };
    if (method === "agents.delete") {
      if (fail.agentsDelete > 0) {
        fail.agentsDelete--;
        throw Object.assign(Error("Assistant Gateway unavailable"), {
          code: "UNAVAILABLE",
        });
      }
      deletedAgents.push(input);
      roster.delete(input.agentId);
      f.profiles.delete(input.agentId);
      for (const job of cron.filter((j) => j.agentId === input.agentId)) {
        removedJobs.push(job.id);
        cron.splice(cron.indexOf(job), 1);
      }
      return { ok: true };
    }
    if (method === "cron.update") {
      if (fail.cronUpdate.has(input.id)) {
        fail.cronUpdate.delete(input.id);
        throw Object.assign(Error("Cron unavailable"), { code: "UNAVAILABLE" });
      }
      updatedJobs.push([input.id, input.patch.enabled]);
      const job = cron.find((j) => j.id === input.id);
      if (job) job.enabled = input.patch.enabled;
      return job || {};
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
      if (fail.jobs.has(agent.runtimeAgentId))
        throw Object.assign(Error("Cron unavailable"), { code: "UNAVAILABLE" });
      return cron.filter((j) => j.agentId === agent.runtimeAgentId);
    },
    heartbeats: {
      async sync(id) {
        synced.push([id, !!f.store.storedAssistant(id).archivedAt]);
      },
    },
    async close() {},
  };
  const db = f.store.db;
  // Every table a delete reaches, made by its own feature.
  const hooks = new HookStore(db);
  new HookEvents(db);
  new RoutineResults(db);
  new RoutineEvents(db);
  db.exec(dismissalTable);
  new LeadShares({ a: { store: f.store } });
  const actions = new AssistantActionStore(db);
  const codingSessions = new AgentSessionStore(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS assistant_access(assistant_id TEXT PRIMARY KEY REFERENCES assistants(id),body TEXT NOT NULL)",
  );
  const channelStore = new ChannelStore({ dataDir: f.dataDir });
  new TelegramFollowUps({ store: channelStore });
  const runs = new RunStore(f.dataDir);
  const memory = new ProjectMemory({ dataDir: f.dataDir, home: f.dataDir });
  t.after(() => {
    channelStore.close?.();
    runs.close?.();
    memory.close?.();
  });
  const channels = {
    list: [],
    store: { list: () => channels.list, db: channelStore.db },
    async forget(id) {
      if (fail.forget.has(id)) {
        fail.forget.delete(id);
        throw Object.assign(Error("Channel busy"), { code: "CHANNEL_BUSY" });
      }
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
  const users = { known: new Set(["anna"]) };
  const services = {
    assistants: f.assistants,
    teams: f.service,
    channels,
    mcpServers,
    paths,
    dataDir: f.dataDir,
    users: {
      get(id) {
        if (!users.known.has(id)) throw Error("User not found");
        return { id };
      },
    },
    audit: { append: (event) => audit.push(auditEvent(event)) },
  };
  const lifecycle = new AgentLifecycle(services);
  f.assistants.lifecycle = lifecycle;
  const insert = (sql, ...args) => db.prepare(sql).run(...args);

  /** Fills every store a delete cleans with rows and files of `agent`. */
  function fill(agent, chat, request, attempt) {
    const id = agent.id;
    insert("INSERT INTO attempt_reviews VALUES(?,?)", attempt.id, "2026-10-27");
    insert(
      "INSERT INTO agent_attachments VALUES(?,?,?,?,?,?,?)",
      `file-${id}`,
      id,
      chat.id,
      request.id,
      0,
      "{}",
      1,
    );
    if (!f.service.store.find(`context:${request.id}`))
      f.service.store.recordContext(request.id, { kind: "owner" });
    insert(
      "INSERT INTO assistant_team_records VALUES(?,?,?,?,?,?,?)",
      `goal-${id}`,
      "work-goal",
      null,
      null,
      "open",
      1,
      JSON.stringify({ id: `goal-${id}`, kind: "work-goal", conversationId: chat.id }),
    );
    insert(
      "INSERT INTO assistant_memory_notes VALUES(?,?,?)",
      `note-${id}`,
      chat.id,
      JSON.stringify({ text: "Private note" }),
    );
    insert(
      "INSERT INTO assistant_routine_results VALUES(?,?,?)",
      `result-${id}`,
      chat.id,
      "{}",
    );
    insert(
      "INSERT INTO assistant_long_chat_dismissals VALUES(?,?,?,?)",
      chat.id,
      "owner",
      1,
      "2026-10-27",
    );
    insert(
      "INSERT INTO assistant_member_long_chats VALUES(?,?,?,?,?,?,?,?)",
      chat.id,
      id,
      1,
      null,
      "pending",
      0,
      0,
      "2026-10-27",
    );
    insert(
      "INSERT INTO assistant_lead_shares VALUES(?,?,?,?)",
      `share-${id}`,
      crypto.randomUUID(),
      id,
      "{}",
    );
    // Which coding session it started; the session itself is the owner's to keep.
    codingSessions.insert({ sessionId: `session-${id}`, assistantId: id, ended: false });
    const channelId = `channel-${id}`;
    channels.list.push({ id: channelId, assistantId: id });
    channelStore.db
      .prepare("INSERT INTO channel_follow_ups VALUES(?,?,?,?)")
      .run(`run-${id}`, channelId, "pending", "{}");
    for (const folder of [
      path.join(root, "memory-backups", agent.runtimeAgentId),
      path.join(root, "shares", id),
      path.join(f.dataDir, "ssh", "agents"),
    ])
      fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(root, "memory-backups", agent.runtimeAgentId, "MEMORY-1.md"),
      "Copy",
    );
    fs.writeFileSync(path.join(root, "shares", id, "report.txt"), "Shared");
    fs.writeFileSync(path.join(f.dataDir, "ssh", "agents", `${id}.lock.sqlite`), "");
  }

  /** An agent with something in every store that a delete cleans. */
  function populated(name = "Helper", origin = null) {
    const agent = f.store.createAssistant({ name, instructions: "Help", model }, origin);
    const chat = f.store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: `chat-${agent.id}`,
      main: true,
      ...(origin?.userAccess && { userId: origin.userAccess.members[0].userId }),
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
    insert("INSERT INTO assistant_routine_events VALUES(?,?,?)", binding.id, "e1", "{}");
    cron.push({
      id: `job-${agent.id}`,
      agentId: agent.runtimeAgentId,
      declarationKey: `agentpier-reminder:${binding.id}`,
      enabled: true,
    });
    // A job the agent created itself, never bound in AgentPier.
    cron.push({ id: `own-${agent.id}`, agentId: agent.runtimeAgentId, enabled: true });
    const hook = hooks.create({ assistantId: agent.id, name: "Deploys" });
    insert(
      "INSERT INTO assistant_hook_events(id,hook_id,assistant_id,event_id,received_at,body) VALUES(?,?,?,?,?,?)",
      `hook-event-${agent.id}`,
      hook.id,
      agent.id,
      "e1",
      1,
      "{}",
    );
    insert(
      "INSERT INTO assistant_actions VALUES(?,?,?,?)",
      `action-${agent.id}`,
      agent.id,
      `op-${agent.id}`,
      JSON.stringify({ id: `action-${agent.id}`, state: "awaiting_approval" }),
    );
    insert(
      "INSERT INTO assistant_access VALUES(?,?)",
      agent.id,
      JSON.stringify({ projectIds: ["p1"] }),
    );
    fill(agent, chat, request, attempt);
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

  /** What is left of agent `id` in each store, by store; empty arrays once deleted. */
  function remains(id) {
    const q = (sql, ...args) => db.prepare(sql).all(...args).length;
    const files = [
      path.join(paths.workspaces, id),
      path.join(root, "shares", id),
      path.join(root, "memory-backups", `ap-${id}`),
      path.join(paths.state, "agents", `ap-${id}`),
      path.join(paths.state, "browser", `agent-${id}`),
      path.join(f.dataDir, "ssh", "agents", `${id}.lock.sqlite`),
    ].filter((file) => fs.existsSync(file));
    const counts = {
      assistants: q("SELECT 1 FROM assistants WHERE id=?", id),
      conversations: q("SELECT 1 FROM conversations WHERE assistant_id=?", id),
      attachments: q("SELECT 1 FROM agent_attachments WHERE assistant_id=?", id),
      requests: q(
        "SELECT 1 FROM requests WHERE conversation_id IN (SELECT id FROM conversations WHERE assistant_id=?)",
        id,
      ),
      attempts: q(
        "SELECT 1 FROM attempts a JOIN requests r ON a.request_id=r.id JOIN conversations c ON r.conversation_id=c.id WHERE c.assistant_id=?",
        id,
      ),
      reviews: q(
        "SELECT 1 FROM attempt_reviews WHERE attempt_id NOT IN (SELECT id FROM attempts)",
      ),
      messages: q(
        "SELECT 1 FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)",
      ),
      notes: q("SELECT 1 FROM assistant_memory_notes WHERE id=?", `note-${id}`),
      routineResults: q(
        "SELECT 1 FROM assistant_routine_results WHERE id=?",
        `result-${id}`,
      ),
      routineEvents: q(
        "SELECT 1 FROM assistant_routine_events WHERE binding_id NOT IN (SELECT id FROM assistant_reminder_bindings)",
      ),
      bindings: q("SELECT 1 FROM assistant_reminder_bindings WHERE assistant_id=?", id),
      hooks: q("SELECT 1 FROM assistant_hooks WHERE assistant_id=?", id),
      hookEvents: q("SELECT 1 FROM assistant_hook_events WHERE assistant_id=?", id),
      dismissals: q(
        "SELECT 1 FROM assistant_long_chat_dismissals WHERE conversation_id NOT IN (SELECT id FROM conversations)",
      ),
      memberLongChats: q(
        "SELECT 1 FROM assistant_member_long_chats WHERE member_id=?",
        id,
      ),
      actions: q("SELECT 1 FROM assistant_actions WHERE assistant_id=?", id),
      access: q("SELECT 1 FROM assistant_access WHERE assistant_id=?", id),
      leadShares: q(
        "SELECT 1 FROM assistant_lead_shares WHERE lead_id=? OR member_assistant_id=?",
        id,
        id,
      ),
      teamRecords: q(
        "SELECT 1 FROM assistant_team_records WHERE id=? OR parent_id=? OR id=? OR id=?",
        id,
        id,
        `goal-${id}`,
        `policy:${id}`,
      ),
      contexts: q(
        "SELECT 1 FROM assistant_team_records WHERE kind='context' AND substr(id,9) NOT IN (SELECT id FROM requests)",
      ),
      codingSessions: q("SELECT 1 FROM agent_coding_sessions WHERE assistant_id=?", id),
      followUps: channelStore.db
        .prepare("SELECT 1 FROM channel_follow_ups WHERE channel_id=?")
        .all(`channel-${id}`).length,
    };
    return {
      files,
      rows: Object.fromEntries(Object.entries(counts).filter(([, n]) => n)),
    };
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
    channelStore,
    runs,
    memory,
    cron,
    removedJobs,
    deletedAgents,
    updatedJobs,
    roster,
    audit,
    forgotten,
    unbound,
    disabled,
    synced,
    fail,
    users,
    populated,
    fill,
    remains,
    model,
  };
}

/** A lead with `count` finished task members; `keep` of them kept as permanent agents.*/
export async function leadWithMembers(f, { count = 2, keep = 0 } = {}) {
  const { team, parent, attempt } = await f.proposal({ count });
  await f.service.reconcile();
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId);
  await f.service.reconcile();
  const members = f.service.store.members(team.id);
  for (const m of members.slice(0, keep)) f.service.store.promote(m.id, m.revision);
  // The lead's own turn that proposed the team ends too.
  f.assistants.ledger.transition(attempt.id, "completed");
  return { lead: f.store.getAssistant(parent.id), team, members };
}
