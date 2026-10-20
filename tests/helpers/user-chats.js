import { EventEmitter } from "node:events";
import { applicationFixture, enabledAssistants } from "./application.js";
import { signedInUser } from "./users.js";
import { fixtureModel } from "./user-agents.js";
import { telegramMessage } from "./assistant-channel-fixture.js";

/**
 * A scripted Gateway behind the fixture's agent service: sessions.create returns a
 * new key per label, sends are recorded and `history[key]` serves chat.history.
 * Agents compile nothing (config.apply is a no-op).
 */
export function fakeGateway(f) {
  const assistants = f.application.assistants;
  const client = new EventEmitter();
  const gateway = {
    client,
    created: [],
    sent: [],
    calls: [],
    history: {},
    runs: {},
    jobs: new Map(),
  };
  client.ready = true;
  // The supervisor closes its client on shutdown.
  client.close = () => {
    client.ready = false;
  };
  client.subscribe = (listener) => {
    client.on("event", listener);
    return () => client.off("event", listener);
  };
  client.call = async (method, params) => {
    gateway.calls.push({ method, params });
    if (method === "sessions.create") {
      gateway.created.push(params);
      return { key: `agent:${params.agentId}:${gateway.created.length}` };
    }
    if (method === "sessions.send") {
      gateway.sent.push(params);
      return { runId: params.idempotencyKey };
    }
    if (method === "chat.history")
      return { messages: gateway.history[params.sessionKey] || [], hasMore: false };
    if (method === "agent.wait")
      return gateway.runs[params.runId]
        ? { ...gateway.runs[params.runId], runId: params.runId }
        : { status: "timeout" };
    if (method === "sessions.abort") {
      gateway.runs[params.runId] = { status: "aborted" };
      return {};
    }
    if (method === "sessions.delete") return { deleted: true };
    // Native cron jobs for reminders, routines and check-ins.
    if (method === "cron.list")
      return {
        jobs: [...gateway.jobs.values()].filter((j) => j.agentId === params.agentId),
        hasMore: false,
      };
    if (method === "cron.add") {
      const job = {
        ...params,
        id: `job-${gateway.jobs.size + 1}`,
        updatedAtMs: 1,
        state: {},
      };
      gateway.jobs.set(job.id, job);
      return { created: true, job };
    }
    if (method === "cron.update") {
      const job = { ...gateway.jobs.get(params.id), ...params.patch, updatedAtMs: 2 };
      gateway.jobs.set(job.id, job);
      return job;
    }
    if (method === "cron.remove") {
      gateway.jobs.delete(params.id);
      return { removed: true };
    }
    if (method === "cron.runs") return { entries: [] };
    if (method === "sessions.describe") return { session: {} };
    return {};
  };
  assistants.runtime.client = client;
  assistants.config.apply = async () => {};
  return gateway;
}

/** The fixture with a fake Gateway and the owner's request helper. */
export async function chatFixture(t, overrides = {}) {
  const f = await applicationFixture(t, { ...enabledAssistants, ...overrides });
  const gateway = fakeGateway(f);
  return { f, gateway };
}

/** Creates an agent for users through the owner's API. */
export async function userAgent(f, userAccess, body = {}) {
  const response = await f.request("/api/user-agents", {
    method: "POST",
    body: {
      name: body.name || "Family",
      instructions: "",
      model: fixtureModel(f),
      ...body,
      userAccess,
    },
  });
  if (response.status !== 201)
    throw new Error(`User agent not created: ${await response.text()}`);
  return response.json();
}

/** Two signed-in users and a shared agent of both at `level`. */
export async function sharedAgentOfTwo(f, level = "chat", names = ["Anna", "Ben"]) {
  const anna = await signedInUser(f, names[0]);
  const ben = await signedInUser(f, names[1]);
  const agent = await userAgent(f, {
    mode: "shared",
    members: [
      { userId: anna.user.id, level },
      { userId: ben.user.id, level },
    ],
  });
  return { anna, ben, agent };
}

/** A request as the signed-in user behind `cookie`. */
export const as =
  (f, cookie) =>
  (endpoint, options = {}) =>
    f.request(endpoint, { ...options, headers: { cookie, ...options.headers } });

/**
 * Connects and pairs the Telegram bot of a user's own agent (Extended) through her
 * routes; Telegram itself is faked. Returns the channel record.
 */
export async function pairedTelegram(f, request, agentId) {
  const channels = f.application.assistantChannels;
  channels.clientFactory = () => ({
    identity: async () => ({ id: 777, username: "anna_helper_bot" }),
  });
  const connected = await request(`/api/me/agents/${agentId}/telegram`, {
    method: "PUT",
    body: { token: "123456:user-bot-secret-token", language: "en" },
  });
  if (connected.status !== 200) throw new Error(await connected.text());
  const { channel } = await connected.json();
  const paired = await request(`/api/me/agents/${agentId}/telegram/pair`, {
    method: "POST",
    body: {},
  });
  const { code } = await paired.json();
  await channels.ingress.receive(channel.id, [telegramMessage(1, `/start ${code}`)]);
  return channels.store.get(channel.id);
}
