import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";

// The long-chat hint's actions (AGENTPIER-186): Summarise now asks OpenClaw's
// `sessions.compact` for the chat's own session; Hide keeps the hint away until the
// context grew clearly further.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

const routes = (user) => ({
  open: (agentId) =>
    user
      ? `/api/me/agents/${agentId}/conversation`
      : `/api/assistants/${agentId}/conversations`,
  chats: (agentId) =>
    user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`,
  chat: (id) =>
    user ? `/api/me/conversations/${id}` : `/api/assistant-conversations/${id}`,
});

const long = { totalTokens: 120000, totalTokensFresh: true, contextTokens: 200000 };

/**
 * The fixture's fake Gateway with session sizes (`sizes[key]`, chat.history's
 * sessionInfo) and a scripted `sessions.compact`: `compact(key)` answers it, by
 * default a compaction that leaves the context small.
 */
async function longChatFixture(t) {
  const { f, gateway } = await chatFixture(t);
  const sizes = {};
  const base = gateway.client.call;
  gateway.compact = async (key) => {
    sizes[key] = { ...sizes[key], totalTokens: 9000, totalTokensFresh: false };
    return { ok: true, key, compacted: true, result: { tokensAfter: 9000 } };
  };
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.compact") {
      gateway.calls.push({ method, params });
      return gateway.compact(params.key);
    }
    if (method === "chat.history") {
      gateway.calls.push({ method, params });
      return {
        messages: gateway.history[params.sessionKey] || [],
        hasMore: false,
        ...(sizes[params.sessionKey] && { sessionInfo: sizes[params.sessionKey] }),
      };
    }
    return base(method, params, options);
  };
  const keyOf = (id) =>
    f.application.assistants.store.getConversation(id).runtimeSessionKey;
  return { f, gateway, sizes, keyOf };
}

async function ownerChat(f) {
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f) },
    }),
    201,
  );
  const main = (
    await json(await f.request(routes(false).open(agent.id), { method: "POST" }), 200)
  ).id;
  return { agent, main };
}

const compacts = (gateway) =>
  gateway.calls.filter((c) => c.method === "sessions.compact");

test("the owner summarises his long main chat in its own session", async (t) => {
  const { f, gateway, sizes, keyOf } = await longChatFixture(t);
  const { main } = await ownerChat(f);
  const r = routes(false);
  sizes[keyOf(main)] = long;
  assert.equal(
    (await json(await f.request(`${r.chat(main)}/messages`), 200)).longChat,
    true,
  );
  // While OpenClaw summarises, the chat shows it and takes no turn.
  let finish;
  gateway.compact = (key) =>
    new Promise((resolve) => {
      finish = () => {
        sizes[key] = { ...long, totalTokens: 8000, totalTokensFresh: false };
        resolve({ ok: true, key, compacted: true });
      };
    });
  const summarised = f.request(`${r.chat(main)}/compact`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const during = await json(await f.request(`${r.chat(main)}/messages`), 200);
  assert.equal(during.compacting, true);
  const sent = await f.request(`${r.chat(main)}/messages`, {
    method: "POST",
    body: { clientRequestId: "during", text: "Hello" },
  });
  assert.equal(sent.status, 409);
  const archived = await f.request(`${r.chat(main)}/archive`, { method: "POST" });
  assert.equal(archived.status, 409);
  finish();
  assert.deepEqual(await json(await summarised, 200), { compacted: true });
  assert.deepEqual(
    compacts(gateway).map((c) => c.params),
    [{ key: keyOf(main) }],
  );
  // The key, the chat and its main role stay; the hint goes with the fresh size.
  const store = f.application.assistants.store;
  assert.equal(store.getConversation(main).main, true);
  const after = await json(await f.request(`${r.chat(main)}/messages`), 200);
  assert.equal(after.compacting, false);
  assert.equal("longChat" in after, false);
  assert.ok(!gateway.calls.some((c) => c.method === "sessions.reset"));
});

test("a double click summarises once", async (t) => {
  const { f, gateway, sizes, keyOf } = await longChatFixture(t);
  const { main } = await ownerChat(f);
  sizes[keyOf(main)] = long;
  // The second click arrives while OpenClaw still summarises.
  const slow = gateway.compact;
  gateway.compact = (key) =>
    new Promise((resolve) => setTimeout(() => resolve(slow(key)), 200));
  const [one, two] = await Promise.all([
    f.request(`${routes(false).chat(main)}/compact`, { method: "POST" }),
    f.request(`${routes(false).chat(main)}/compact`, { method: "POST" }),
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(compacts(gateway).length, 1);
});

test("a user summarises and hides the hint of her own chat only", async (t) => {
  const { f, gateway, sizes, keyOf } = await longChatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const annaRequest = as(f, anna.cookie);
  const benRequest = as(f, ben.cookie);
  const r = routes(true);
  const annaMain = (
    await json(await annaRequest(r.open(agent.id), { method: "POST" }), 200)
  ).id;
  const benMain = (
    await json(await benRequest(r.open(agent.id), { method: "POST" }), 200)
  ).id;
  sizes[keyOf(annaMain)] = long;
  sizes[keyOf(benMain)] = long;
  // Another user's chat is the unknown route.
  for (const action of ["compact", "long-chat-dismissal"]) {
    const response = await annaRequest(`${r.chat(benMain)}/${action}`, {
      method: "POST",
    });
    assert.equal(response.status, 404, action);
    assert.deepEqual(await response.json(), notFoundBody());
  }
  assert.equal(compacts(gateway).length, 0);
  // Her own: hidden, then summarised.
  await json(
    await annaRequest(`${r.chat(annaMain)}/long-chat-dismissal`, { method: "POST" }),
    200,
  );
  assert.equal(
    "longChat" in (await json(await annaRequest(`${r.chat(annaMain)}/messages`), 200)),
    false,
  );
  // Ben still sees his own hint: a hidden hint is per person and chat.
  assert.equal(
    (await json(await benRequest(`${r.chat(benMain)}/messages`), 200)).longChat,
    true,
  );
  await json(await annaRequest(`${r.chat(annaMain)}/compact`, { method: "POST" }), 200);
  assert.deepEqual(
    compacts(gateway).map((c) => c.params.key),
    [keyOf(annaMain)],
  );
});

test("the owner neither summarises nor hides the hint of a user's chat", async (t) => {
  const { f, gateway, sizes, keyOf } = await longChatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const main = (
    await json(await as(f, cookie)(routes(true).open(agent.id), { method: "POST" }), 200)
  ).id;
  sizes[keyOf(main)] = long;
  await json(
    await f.request(`/api/users/${user.id}/owner-may-read`, {
      method: "PUT",
      body: { enabled: true },
    }),
    200,
  );
  // Under her opt-in he reads her chat, without its hint.
  const read = await json(await f.request(`${routes(false).chat(main)}/messages`), 200);
  assert.equal("longChat" in read, false);
  for (const action of ["compact", "long-chat-dismissal"]) {
    const response = await f.request(`${routes(false).chat(main)}/${action}`, {
      method: "POST",
    });
    assert.equal(response.status, 404, action);
  }
  assert.equal(compacts(gateway).length, 0);
});

test("a busy or archived chat is not summarised", async (t) => {
  const { f, gateway, sizes, keyOf } = await longChatFixture(t);
  const { agent, main } = await ownerChat(f);
  const r = routes(false);
  sizes[keyOf(main)] = long;
  await json(
    await f.request(`${r.chat(main)}/messages`, {
      method: "POST",
      body: { clientRequestId: "a", text: "Work on it" },
    }),
    202,
  );
  const busy = await f.request(`${r.chat(main)}/compact`, { method: "POST" });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, "CHAT_BUSY");
  const second = (await json(await f.request(r.chats(agent.id), { method: "POST" }), 201))
    .id;
  await json(await f.request(`${r.chat(second)}/archive`, { method: "POST" }), 200);
  for (const action of ["compact", "long-chat-dismissal"]) {
    const archived = await f.request(`${r.chat(second)}/${action}`, { method: "POST" });
    assert.equal(archived.status, 409, action);
    assert.equal((await archived.json()).code, "CHAT_ARCHIVED");
  }
  assert.equal(compacts(gateway).length, 0);
});

test("the Gateway's refusals show as the chat's problems", async (t) => {
  const { f, gateway, sizes, keyOf } = await longChatFixture(t);
  const { main } = await ownerChat(f);
  const endpoint = `${routes(false).chat(main)}/compact`;
  sizes[keyOf(main)] = long;
  const answered = (code, remoteMessage) =>
    Object.assign(Error("refused"), { code, answered: true, remoteMessage });
  for (const [answer, status, code] of [
    [
      { ok: true, compacted: false, reason: "no transcript" },
      409,
      "CHAT_COMPACT_NOTHING",
    ],
    [
      { ok: false, compacted: false, reason: "nothing to compact" },
      409,
      "CHAT_COMPACT_NOTHING",
    ],
    [
      answered(
        "INVALID_REQUEST",
        `Session x has an active run; retry after it finishes.`,
      ),
      409,
      "CHAT_BUSY",
    ],
    [answered("UNAVAILABLE", "Error: model refused"), 502, "CHAT_COMPACT_FAILED"],
    // OpenClaw answers a failed summary as a successful call.
    [
      { ok: false, compacted: false, reason: "401 Unauthorized from provider" },
      502,
      "CHAT_COMPACT_FAILED",
    ],
    [
      { ok: false, compacted: false, reason: "busy", failure: { reason: "active_run" } },
      409,
      "CHAT_BUSY",
    ],
    [
      { ok: false, compacted: false, reason: "Already compacted" },
      409,
      "CHAT_COMPACT_NOTHING",
    ],
  ]) {
    gateway.compact = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const response = await f.request(endpoint, { method: "POST" });
    assert.equal(response.status, status, code);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.error, "string");
  }
  // A Gateway that went away is the service's own 503.
  gateway.compact = async () => {
    throw Object.assign(Error("gone"), { code: "UNAVAILABLE" });
  };
  assert.equal((await f.request(endpoint, { method: "POST" })).status, 503);
  // Nothing stays busy after a refusal.
  assert.equal(
    (await json(await f.request(`${routes(false).chat(main)}/messages`), 200)).compacting,
    false,
  );
});

test("a hidden hint returns once the context grew clearly further", async (t) => {
  const { f, sizes, keyOf } = await longChatFixture(t);
  const { main } = await ownerChat(f);
  const r = routes(false);
  const key = keyOf(main);
  const hint = async () =>
    (await json(await f.request(`${r.chat(main)}/messages`), 200)).longChat === true;
  sizes[key] = long;
  await json(
    await f.request(`${r.chat(main)}/long-chat-dismissal`, { method: "POST" }),
    200,
  );
  assert.equal(await hint(), false);
  // Hidden at 120k: back from 170k (+50k, less than half again).
  sizes[key] = { ...long, totalTokens: 169999 };
  assert.equal(await hint(), false);
  sizes[key] = { ...long, totalTokens: 170000 };
  assert.equal(await hint(), true);
  // Hidden again there; it stays hidden across a restart of the service's state.
  await json(
    await f.request(`${r.chat(main)}/long-chat-dismissal`, { method: "POST" }),
    200,
  );
  assert.equal(await hint(), false);
  const { LongChats } = await import("../../server/features/assistants/long-chats.js");
  const assistants = f.application.assistants;
  assistants.longChats = new LongChats(assistants);
  assert.equal(await hint(), false);
  sizes[key] = { ...long, totalTokens: 220000 };
  assert.equal(await hint(), true);
});
