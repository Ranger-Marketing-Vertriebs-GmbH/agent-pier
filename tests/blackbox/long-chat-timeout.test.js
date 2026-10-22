import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { compactEndOf } from "../../server/features/assistants/compaction-watch.js";

// AGENTPIER-190: a summary on request that outlives its request's timeout keeps the
// chat compacting until the Gateway ends it (server long-chats.js,
// compaction-watch.js). OpenClaw holds the session's lifecycle lock meanwhile, so a
// send would only wait for it and turn uncertain: the chat queues instead.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

// The separate connection the watch subscribes on (GatewayClient.sibling).
function fakeSibling(watch) {
  const sibling = new EventEmitter();
  sibling.connect = async () => {};
  sibling.call = async (method, params) => {
    watch.calls.push({ method, params });
    return { subscribed: true };
  };
  sibling.subscribe = (listener) => {
    sibling.on("event", listener);
    return () => sibling.off("event", listener);
  };
  sibling.close = () => {
    watch.closed++;
    sibling.removeAllListeners("event");
  };
  watch.siblings.push(sibling);
  return sibling;
}

async function fixture(t, timing = {}) {
  const { f, gateway } = await chatFixture(t);
  const assistants = f.application.assistants;
  assistants.longChats.timing = { answerMs: 80, maxMs: 60000, pollMs: 40, ...timing };
  // The fixture never starts its runtime; the watch asks whether it is up.
  assistants.runtime.state.availability = "ready";
  // The Gateway compacts and never answers until the test says so.
  const compact = {};
  const watch = { calls: [], closed: 0, siblings: [] };
  const base = gateway.client.call;
  gateway.markers = [];
  gateway.historyFails = 0;
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.compact") {
      gateway.calls.push({ method, params });
      return new Promise((resolve, reject) =>
        Object.assign(compact, { resolve, reject }),
      );
    }
    if (method === "chat.history") {
      gateway.calls.push({ method, params });
      if (gateway.historyFails > 0) {
        gateway.historyFails--;
        throw Object.assign(Error("slow"), { code: "TIMEOUT" });
      }
      return {
        messages: [
          ...(gateway.history[params.sessionKey] || []),
          ...gateway.markers.map((marker) => ({
            role: "system",
            ...(typeof marker === "string" ? {} : { timestamp: marker.timestamp }),
            __openclaw: { kind: "compaction", id: marker.id ?? marker },
          })),
        ],
        hasMore: false,
      };
    }
    return base(method, params, options);
  };
  gateway.client.sibling = () => fakeSibling(watch);
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f) },
    }),
    201,
  );
  const id = (
    await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
      200,
    )
  ).id;
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  const chat = `/api/assistant-conversations/${id}`;
  const history = async () => json(await f.request(`${chat}/messages`), 200);
  const sends = () => gateway.calls.filter((c) => c.method === "sessions.send");
  // Summarise; the request answers once its own timeout passed.
  const summarise = async () => {
    const response = await f.request(`${chat}/compact`, { method: "POST" });
    return json(response, 200);
  };
  const end = (completed = true) =>
    watch.siblings.at(-1).emit("event", {
      event: "session.operation",
      payload: { operation: "compact", phase: "end", sessionKey: key, completed },
    });
  return {
    f,
    gateway,
    assistants,
    compact,
    watch,
    key,
    chat,
    history,
    sends,
    summarise,
    end,
  };
}

test("a summary that outlives its request keeps the chat compacting, queues the owner's message and sends it once at its end", async (t) => {
  const { f, chat, history, sends, summarise, end, watch, compact } = await fixture(t);
  const answer = await summarise();
  // Not a failure: the summary still runs.
  assert.deepEqual(answer, { compacted: false, running: true });
  assert.equal((await history()).compacting, true);
  // A send is refused while it runs and never reaches the Gateway; the queue holds it.
  const refused = await f.request(`${chat}/messages`, {
    method: "POST",
    body: { clientRequestId: "early", text: "Are you there?" },
  });
  assert.equal(refused.status, 409);
  await json(
    await f.request(`${chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  await tick(120);
  assert.equal(sends().length, 0);
  assert.equal((await history()).compacting, true);
  // The watch subscribed to session events on its own connection.
  await until(
    () => watch.calls.some((c) => c.method === "sessions.subscribe"),
    "the session subscription",
  );
  end();
  await until(() => sends().length === 1, "the queued message");
  const after = await history();
  assert.equal(after.compacting, false);
  assert.equal(after.queued, null);
  assert.equal(after.compactOutcome, undefined);
  assert.ok(watch.closed >= 1, "the watch connection is closed");
  // The Gateway's late answer changes nothing and sends nothing again.
  compact.resolve({ ok: true, compacted: true });
  await tick(120);
  assert.equal(sends().length, 1);
});

test("the Gateway's own late answer ends it too", async (t) => {
  const { f, chat, history, sends, summarise, compact } = await fixture(t);
  await summarise();
  await json(
    await f.request(`${chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  compact.resolve({ ok: true, compacted: true });
  await until(() => sends().length === 1, "the queued message");
  assert.equal((await history()).compacting, false);
});

test("without the event, a new compaction marker in the history ends it", async (t) => {
  const { gateway, history, summarise } = await fixture(t);
  gateway.markers = ["c1"];
  // No separate connection: the read-only poll remains.
  gateway.client.sibling = undefined;
  await summarise();
  await tick(120);
  assert.equal((await history()).compacting, true, "the old marker ends nothing");
  gateway.markers = ["c1", "c2"];
  await until(async () => (await history()).compacting === false, "the marker");
});

test("a compaction that ended without a summary says so, until the next turn", async (t) => {
  const { f, chat, history, summarise, end } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  await tick(60);
  end(false);
  await until(async () => (await history()).compacting === false, "the end");
  assert.equal((await history()).compactOutcome, "failed");
  await json(
    await f.request(`${chat}/messages`, {
      method: "POST",
      body: { clientRequestId: "next", text: "Next" },
    }),
    202,
  );
  assert.equal((await history()).compactOutcome, undefined);
});

const closed = () => Object.assign(Error("closed"), { code: "CLOSED", status: 503 });

test("a dropped connection to the same Gateway keeps the chat compacting until its end", async (t) => {
  const { f, chat, history, sends, summarise, compact, end, watch } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  await json(
    await f.request(`${chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  // GatewayClient.rejectPending on its close; it reconnects to the same Gateway
  // (same client, same generation), which still summarises.
  compact.reject(closed());
  await tick(200);
  assert.equal((await history()).compacting, true);
  assert.equal(sends().length, 0);
  // The event connection dropped with it and is opened again.
  watch.siblings.at(-1).emit("disconnected");
  await until(() => watch.siblings.length >= 2, "a new event connection");
  end();
  await until(() => sends().length === 1, "the queued message");
  await tick(120);
  assert.equal(sends().length, 1);
  assert.equal((await history()).compacting, false);
});

test("a dropped connection before the request answered still answers that it runs", async (t) => {
  const { history, gateway, chat, f, compact, end } = await fixture(t, {
    answerMs: 5000,
  });
  t.mock.method(console, "warn", () => {});
  const answer = f.request(`${chat}/compact`, { method: "POST" });
  await until(
    () => gateway.calls.some((c) => c.method === "sessions.compact"),
    "the compaction",
  );
  compact.reject(closed());
  assert.deepEqual(await json(await answer, 200), { compacted: false, running: true });
  assert.equal((await history()).compacting, true);
  await tick(60);
  end();
  await until(async () => (await history()).compacting === false, "the end");
});

test("a Gateway that goes away frees the chat; the notice outlives the queued message", async (t) => {
  const { f, assistants, chat, history, sends, summarise, compact } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  await json(
    await f.request(`${chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  // The runtime replaced its Gateway: the summary is gone with the old one.
  const generation = assistants.runtime.generationId;
  assistants.runtime.generationId = "restarted";
  t.after(() => (assistants.runtime.generationId = generation));
  compact.reject(closed());
  await until(() => sends().length === 1, "the queued message");
  await tick(120);
  assert.equal(sends().length, 1);
  const after = await history();
  assert.equal(after.compacting, false);
  // The message written during the summary went out; the owner still learns why.
  assert.equal(after.compactOutcome, "interrupted");
  // Once its reply is in, the owner's next turn moves the chat on.
  for (const attempt of assistants.ledger.pending())
    assistants.ledger.transition(attempt.id, "completed");
  await json(
    await f.request(`${chat}/messages`, {
      method: "POST",
      body: { clientRequestId: "after", text: "Read it" },
    }),
    202,
  );
  assert.equal((await history()).compactOutcome, undefined);
});

test("a runtime that is down frees the chat when the connection drops", async (t) => {
  const { assistants, history, summarise, compact } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  assistants.runtime.state.availability = "failed";
  compact.reject(closed());
  await until(async () => (await history()).compacting === false, "the end");
  assert.equal((await history()).compactOutcome, "interrupted");
});

test("the baseline marker is read before the compaction starts", async (t) => {
  const { gateway, history, summarise } = await fixture(t);
  gateway.client.sibling = undefined;
  gateway.markers = ["c1"];
  await summarise();
  const order = gateway.calls
    .map((c) => c.method)
    .filter((m) => ["chat.history", "sessions.compact"].includes(m));
  assert.deepEqual(order.slice(0, 2), ["chat.history", "sessions.compact"]);
  // It committed before the watch's first read: still seen as new.
  gateway.markers = ["c1", "c2"];
  await until(async () => (await history()).compacting === false, "the marker");
});

test("without a baseline, only a marker written since the summary began ends it", async (t) => {
  const { gateway, history, summarise } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  gateway.client.sibling = undefined;
  gateway.markers = [{ id: "old", timestamp: Date.now() - 60000 }];
  gateway.historyFails = 1;
  await summarise();
  await tick(150);
  assert.equal((await history()).compacting, true, "an older marker ends nothing");
  gateway.markers.push({ id: "new", timestamp: Date.now() });
  await until(async () => (await history()).compacting === false, "the new marker");
});

test("an end after the answer is logged with the Gateway's code, and a busy session stays busy", async (t) => {
  const { history, summarise, compact } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  await summarise();
  compact.reject(
    Object.assign(Error("x"), {
      code: "INVALID_REQUEST",
      answered: true,
      remoteMessage: "Session /Users/someone has an active run; retry after it finishes.",
    }),
  );
  await until(async () => (await history()).compacting === false, "the end");
  assert.equal((await history()).compactOutcome, "busy");
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.ok(
    lines.some((l) => /ended after its request: busy INVALID_REQUEST/.test(l)),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => l.includes("/Users/someone")));
});

test("a failing event connection and history read are logged once per watch", async (t) => {
  const { gateway, history, summarise, watch } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  gateway.client.sibling = () => {
    const sibling = fakeSibling(watch);
    sibling.connect = async () => {
      throw Object.assign(Error("pin"), { code: "ENDPOINT_UNTRUSTED" });
    };
    return sibling;
  };
  await summarise();
  gateway.historyFails = 1000;
  await tick(300);
  assert.ok(watch.siblings.length >= 3, "it tries again");
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  const count = (pattern) => lines.filter((l) => pattern.test(l)).length;
  assert.equal(count(/event connection failed: ENDPOINT_UNTRUSTED/), 1, lines.join("\n"));
  assert.equal(count(/reading the history failed: TIMEOUT/), 1, lines.join("\n"));
  assert.equal((await history()).compacting, true);
});

test("a restarted runtime frees the chat even without an answer", async (t) => {
  const { assistants, history, summarise } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  const generation = assistants.runtime.generationId;
  assistants.runtime.generationId = "restarted";
  t.after(() => (assistants.runtime.generationId = generation));
  await until(async () => (await history()).compacting === false, "the restart");
  assert.equal((await history()).compactOutcome, "interrupted");
});

test("the upper bound frees the chat and says the outcome is unknown", async (t) => {
  const { history, summarise, sends } = await fixture(t, { maxMs: 300 });
  t.mock.method(console, "warn", () => {});
  await summarise();
  assert.equal((await history()).compacting, true);
  await until(async () => (await history()).compacting === false, "the bound");
  assert.equal((await history()).compactOutcome, "unknown");
  assert.equal(sends().length, 0);
});

test("only a compact end of the chat's own session counts", () => {
  const frame = (payload) => ({ event: "session.operation", payload });
  const end = { operation: "compact", phase: "end", sessionKey: "agent:a:1" };
  assert.equal(
    compactEndOf(frame({ ...end, completed: true }), "agent:a:1"),
    "compacted",
  );
  assert.equal(compactEndOf(frame({ ...end, completed: false }), "agent:a:1"), "failed");
  assert.equal(compactEndOf(frame({ ...end, phase: "start" }), "agent:a:1"), null);
  assert.equal(
    compactEndOf(frame({ ...end, sessionKey: "agent:a:2" }), "agent:a:1"),
    null,
  );
  assert.equal(compactEndOf(frame({ ...end, operation: "reset" }), "agent:a:1"), null);
  assert.equal(compactEndOf({ event: "agent", payload: end }, "agent:a:1"), null);
});
