import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";

// Regressions from the review of AGENTPIER-186 (server long-chats.js): hidden hints
// after a summary, queued messages, hiding errors, admission and maintenance.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const long = { totalTokens: 150000, totalTokensFresh: true, contextTokens: 200000 };

async function fixture(t) {
  const { f, gateway } = await chatFixture(t);
  const sizes = {};
  const base = gateway.client.call;
  gateway.compact = async (key) => {
    sizes[key] = { ...sizes[key], totalTokens: 60000, totalTokensFresh: false };
    return { ok: true, key, compacted: true };
  };
  gateway.historyError = null;
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.compact") return gateway.compact(params.key);
    if (method === "chat.history") {
      if (gateway.historyError) throw gateway.historyError;
      return {
        messages: gateway.history[params.sessionKey] || [],
        hasMore: false,
        ...(sizes[params.sessionKey] && { sessionInfo: sizes[params.sessionKey] }),
      };
    }
    return base(method, params, options);
  };
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f) },
    }),
    201,
  );
  const main = (
    await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
      200,
    )
  ).id;
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(main).runtimeSessionKey;
  const chat = `/api/assistant-conversations/${main}`;
  const hint = async () =>
    (await json(await f.request(`${chat}/messages`), 200)).longChat === true;
  const rows = () =>
    assistants.store.db.prepare("SELECT * FROM assistant_long_chat_dismissals").all();
  return { f, gateway, sizes, assistants, agent, main, key, chat, hint, rows };
}

// Holds the next compaction open until the returned function is called.
function held(gateway) {
  let release;
  const done = gateway.compact;
  gateway.compact = (key) =>
    new Promise((resolve) => {
      release = () => resolve(done(key));
    });
  return () => release();
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a summary forgets the hidden hint, so the chat shows it once it is long again", async (t) => {
  const { f, sizes, key, chat, hint, rows } = await fixture(t);
  sizes[key] = long;
  await json(await f.request(`${chat}/long-chat-dismissal`, { method: "POST" }), 200);
  assert.equal(rows().length, 1);
  await json(await f.request(`${chat}/compact`, { method: "POST" }), 200);
  assert.deepEqual(rows(), []);
  // Long again at the size it was hidden at: the hint is back.
  sizes[key] = long;
  assert.equal(await hint(), true);
});

test("a context that shrank below the hidden size (OpenClaw's own summary) shows the hint again", async (t) => {
  const { f, sizes, key, chat, hint, rows } = await fixture(t);
  sizes[key] = { ...long, totalTokens: 180000 };
  await json(await f.request(`${chat}/long-chat-dismissal`, { method: "POST" }), 200);
  assert.equal(await hint(), false);
  sizes[key] = { ...long, totalTokens: 125000 };
  assert.equal(await hint(), true);
  assert.deepEqual(rows(), []);
});

test("a message queued during a summary goes out as soon as it ends", async (t) => {
  const { f, gateway, chat, sizes, key } = await fixture(t);
  sizes[key] = long;
  const release = held(gateway);
  const summarised = f.request(`${chat}/compact`, { method: "POST" });
  await tick();
  await json(
    await f.request(`${chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  await tick();
  assert.equal(gateway.sent.length, 0);
  release();
  await json(await summarised, 200);
  for (let i = 0; i < 20 && !gateway.sent.length; i++) await tick();
  assert.equal(gateway.sent.length, 1);
  const history = await json(await f.request(`${chat}/messages`), 200);
  assert.equal(history.queued, null);
});

test("hiding the hint maps the Gateway's answers", async (t) => {
  const { f, gateway, sizes, key, chat, rows } = await fixture(t);
  // No size: nothing to hide, nothing stored.
  assert.deepEqual(
    await json(await f.request(`${chat}/long-chat-dismissal`, { method: "POST" }), 200),
    { dismissed: false },
  );
  sizes[key] = long;
  gateway.historyError = Object.assign(Error("x"), {
    code: "UNAVAILABLE",
    answered: true,
  });
  const refused = await f.request(`${chat}/long-chat-dismissal`, { method: "POST" });
  assert.equal(refused.status, 502);
  assert.equal((await refused.json()).code, "CHAT_HINT_FAILED");
  gateway.historyError = Object.assign(Error("x"), { code: "UNAVAILABLE" });
  const gone = await f.request(`${chat}/long-chat-dismissal`, { method: "POST" });
  assert.equal(gone.status, 503);
  assert.deepEqual(rows(), []);
});

test("a chat deleted while its size is read stores no hidden hint", async (t) => {
  const { f, gateway, sizes, assistants, agent, rows } = await fixture(t);
  const second = (
    await json(
      await f.request(`/api/assistants/${agent.id}/chats`, { method: "POST" }),
      201,
    )
  ).id;
  const secondKey = assistants.store.getConversation(second).runtimeSessionKey;
  sizes[secondKey] = long;
  const call = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    const result = await call(method, params, options);
    if (
      method === "chat.history" &&
      params.sessionKey === secondKey &&
      params.limit === 1
    )
      await json(
        await f.request(`/api/assistant-conversations/${second}`, {
          method: "DELETE",
          body: { confirm: true },
        }),
        204,
      ).catch(() => {});
    return result;
  };
  const response = await f.request(
    `/api/assistant-conversations/${second}/long-chat-dismissal`,
    {
      method: "POST",
    },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(rows(), []);
});
