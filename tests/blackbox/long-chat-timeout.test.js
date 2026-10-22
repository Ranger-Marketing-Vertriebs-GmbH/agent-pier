import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { compactOutcome } from "../../server/features/assistants/compaction-watch.js";

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

async function fixture(t, timing = {}) {
  const { f, gateway } = await chatFixture(t);
  const assistants = f.application.assistants;
  assistants.longChats.timing = {
    answerMs: 80,
    maxMs: 60000,
    lostMs: 60000,
    pollMs: 40,
    ...timing,
  };
  // The fixture never starts its runtime; the watch asks whether it is up.
  assistants.runtime.state.availability = "ready";
  // The Gateway compacts and never answers until the test says so.
  const compact = {};
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
  const queue = async (text) =>
    json(await f.request(`${chat}/queued`, { method: "POST", body: { text } }), 200);
  const send = async (clientRequestId) =>
    f.request(`${chat}/messages`, {
      method: "POST",
      body: { clientRequestId, text: "Now" },
    });
  const free = () => until(async () => (await history()).compacting === false, "the end");
  return {
    f,
    gateway,
    assistants,
    compact,
    key,
    chat,
    history,
    sends,
    summarise,
    queue,
    send,
    free,
  };
}

const closed = () => Object.assign(Error("closed"), { code: "CLOSED", status: 503 });
const answered = (code, remoteMessage) =>
  Object.assign(Error("refused"), {
    code,
    answered: true,
    remoteMessage,
    remoteError: "ModelError",
  });

test("a summary that outlives its request keeps the chat compacting, queues the owner's message and sends it once at its end", async (t) => {
  const { history, sends, summarise, compact, send, queue, free } = await fixture(t);
  // Not a failure: the summary still runs.
  assert.deepEqual(await summarise(), { compacted: false, running: true });
  assert.equal((await history()).compacting, true);
  // A send is refused while it runs and never reaches the Gateway; the queue holds it.
  assert.equal((await send("early")).status, 409);
  await queue("Later");
  await tick(120);
  assert.equal(sends().length, 0);
  assert.equal((await history()).compacting, true);
  // The Gateway's answer is the end.
  compact.resolve({ ok: true, compacted: true });
  await until(() => sends().length === 1, "the queued message");
  await free();
  await tick(120);
  assert.equal(sends().length, 1);
  const after = await history();
  assert.equal(after.queued, null);
  assert.equal(after.compactOutcome, undefined);
});

test("one Gateway result gives one outcome", () => {
  for (const result of [
    { ok: true, compacted: false, reason: "no transcript" },
    { ok: false, compacted: false, reason: "nothing to compact" },
  ])
    assert.equal(compactOutcome({ result }), "nothing");
  assert.equal(compactOutcome({ result: { ok: true, compacted: true } }), "compacted");
  // Answered failures (embedded-agent, resource-loader in OpenClaw 2026.10.3).
  for (const reason of ["compaction aborted", "Error: 401 from provider", "boom"])
    assert.equal(
      compactOutcome({ result: { ok: false, compacted: false, reason } }),
      "failed",
      reason,
    );
  assert.equal(
    compactOutcome({
      result: {
        ok: false,
        compacted: false,
        reason: "x",
        failure: { reason: "model_selection_locked" },
      },
    }),
    "failed",
  );
  assert.equal(
    compactOutcome({
      result: {
        ok: false,
        compacted: false,
        reason: "x",
        failure: { reason: "active_run" },
      },
    }),
    "busy",
  );
  for (const reason of ["Already compacted", "Nothing to compact (session too small)"])
    assert.equal(
      compactOutcome({ result: { ok: false, compacted: false, reason } }),
      "nothing",
      reason,
    );
  assert.equal(
    compactOutcome({ result: { ok: true, compacted: false, reason: "deferred" } }),
    "nothing",
  );
  const busy = answered("INVALID_REQUEST", "Session x has an active run; retry.");
  assert.equal(compactOutcome({ error: busy }), "busy");
  assert.equal(compactOutcome({ error: answered("UNAVAILABLE", "x") }), "failed");
  assert.equal(compactOutcome({ error: { code: "TIMEOUT" } }), "unknown");
  assert.equal(compactOutcome({ error: closed() }), "lost");
  assert.equal(compactOutcome({ error: { code: "UNAVAILABLE" } }), "interrupted");
});

test("the notice outlives the queued message, also one edited before it went out", async (t) => {
  const { assistants, history, sends, summarise, compact, send, queue, free } =
    await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  await queue("Later");
  // Extended: a new delivery key.
  await queue("and more");
  compact.resolve({ ok: true, compacted: false, reason: "no transcript" });
  await until(() => sends().length === 1, "the queued message");
  await free();
  await tick(120);
  assert.equal((await history()).compactOutcome, "nothing");
  // Once its reply is in, the owner's next turn moves the chat on.
  for (const attempt of assistants.ledger.pending())
    assistants.ledger.transition(attempt.id, "completed");
  assert.equal((await send("after")).status, 202);
  assert.equal((await history()).compactOutcome, undefined);
});

test("an end after the answer is logged with the Gateway's code, never its text", async (t) => {
  const { history, summarise, compact, free } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  await summarise();
  compact.reject(answered("UNAVAILABLE", "Error: /Users/someone/secret"));
  await free();
  assert.equal((await history()).compactOutcome, "failed");
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.ok(
    lines.some((l) =>
      /ended after its request: failed UNAVAILABLE \(ModelError\)/.test(l),
    ),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => l.includes("/Users/someone")));
});

test("a failed summary answered as a successful call is a failure, also late", async (t) => {
  const { history, summarise, compact, free } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  compact.resolve({ ok: false, compacted: false, reason: "Error: 401 /Users/x" });
  await free();
  assert.equal((await history()).compactOutcome, "failed");
});

test("an active run answered after the request is a refusal, also late", async (t) => {
  const { history, summarise, compact, free } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  compact.resolve({
    ok: false,
    compacted: false,
    reason: "x",
    failure: { reason: "active_run" },
  });
  await free();
  assert.equal((await history()).compactOutcome, "busy");
});

test("a dropped call is logged with its code, whether the Gateway runs on or not", async (t) => {
  const { assistants, history, summarise, compact, free } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  await summarise();
  compact.reject(closed());
  await tick(100);
  assert.equal((await history()).compacting, true);
  const dropped = () =>
    warn.mock.calls
      .map((c) => c.arguments.join(" "))
      .filter((l) => /the call failed: CLOSED/.test(l)).length;
  assert.equal(dropped(), 1);
  // Gone: a second summary whose call drops on a stopping runtime.
  assistants.runtime.state.availability = "stopping";
  await free();
  assistants.runtime.state.availability = "ready";
  await summarise();
  assistants.runtime.state.availability = "stopping";
  compact.reject(closed());
  await free();
  assert.equal(dropped(), 2);
  assert.equal((await history()).compactOutcome, "interrupted");
});

test("a refusal after the answer stays a refusal", async (t) => {
  const { history, summarise, compact, free } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await summarise();
  compact.reject(answered("INVALID_REQUEST", "Session x has an active run; retry."));
  await free();
  assert.equal((await history()).compactOutcome, "busy");
});

test("after a dropped call to the same Gateway, a new compaction marker ends it", async (t) => {
  const { gateway, history, sends, summarise, compact, queue, free } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  gateway.markers = ["c1"];
  await summarise();
  await queue("Later");
  // GatewayClient.rejectPending on its close; it reconnects to the same Gateway
  // (same client, same generation), which still summarises.
  compact.reject(closed());
  await tick(200);
  assert.equal((await history()).compacting, true);
  assert.equal(sends().length, 0);
  gateway.markers = ["c1", "c2"];
  await until(() => sends().length === 1, "the queued message");
  await free();
  assert.equal((await history()).compactOutcome, undefined);
});

test("after a dropped call, a summary that leaves no marker frees the chat after the short bound", async (t) => {
  const { history, summarise, compact, free } = await fixture(t, { lostMs: 300 });
  t.mock.method(console, "warn", () => {});
  await summarise();
  compact.reject(closed());
  await tick(120);
  assert.equal((await history()).compacting, true);
  await free();
  assert.equal((await history()).compactOutcome, "unknown");
});

test("a dropped call before the request answered still answers that it runs", async (t) => {
  const { gateway, f, chat, history, compact } = await fixture(t, { answerMs: 5000 });
  t.mock.method(console, "warn", () => {});
  const answer = f.request(`${chat}/compact`, { method: "POST" });
  await until(
    () => gateway.calls.some((c) => c.method === "sessions.compact"),
    "the compaction",
  );
  compact.reject(closed());
  assert.deepEqual(await json(await answer, 200), { compacted: false, running: true });
  assert.equal((await history()).compacting, true);
});

for (const [name, change] of [
  ["a stopping runtime", (runtime) => (runtime.state.availability = "stopping")],
  ["a failed runtime", (runtime) => (runtime.state.availability = "failed")],
  ["a replaced Gateway", (runtime) => (runtime.generationId = "restarted")],
]) {
  test(`${name} ends the summary before the request answered: 503`, async (t) => {
    const { assistants, gateway, f, chat, history, compact } = await fixture(t, {
      answerMs: 5000,
    });
    t.mock.method(console, "warn", () => {});
    const generation = assistants.runtime.generationId;
    t.after(() => (assistants.runtime.generationId = generation));
    const answer = f.request(`${chat}/compact`, { method: "POST" });
    await until(
      () => gateway.calls.some((c) => c.method === "sessions.compact"),
      "the compaction",
    );
    change(assistants.runtime);
    compact.reject(closed());
    assert.equal((await answer).status, 503);
    assert.equal((await history()).compacting, false);
  });

  test(`${name} ends a summary that outlived its request`, async (t) => {
    const { assistants, history, summarise, compact, free } = await fixture(t);
    t.mock.method(console, "warn", () => {});
    const generation = assistants.runtime.generationId;
    t.after(() => (assistants.runtime.generationId = generation));
    await summarise();
    compact.reject(closed());
    await tick(100);
    assert.equal((await history()).compacting, true);
    // The poll notices it.
    change(assistants.runtime);
    await free();
    assert.equal((await history()).compactOutcome, "interrupted");
  });
}

test("the baseline marker is read before the compaction starts", async (t) => {
  const { gateway, history, summarise, compact } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  gateway.markers = ["c1"];
  await summarise();
  const order = gateway.calls
    .map((c) => c.method)
    .filter((m) => ["chat.history", "sessions.compact"].includes(m));
  assert.deepEqual(order.slice(0, 2), ["chat.history", "sessions.compact"]);
  // It committed while the call was out, then the call dropped.
  gateway.markers = ["c1", "c2"];
  compact.reject(closed());
  await until(async () => (await history()).compacting === false, "the marker");
});

test("without a baseline, only a marker written since the summary began ends it, and the failed read is logged once", async (t) => {
  const { gateway, history, summarise, compact, free } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  gateway.markers = [{ id: "old", timestamp: Date.now() - 60000 }];
  gateway.historyFails = 1;
  await summarise();
  compact.reject(closed());
  await tick(150);
  assert.equal((await history()).compacting, true, "an older marker ends nothing");
  gateway.markers.push({ id: "new", timestamp: Date.now() });
  await free();
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.equal(
    lines.filter((l) => /reading the history before it failed: TIMEOUT/.test(l)).length,
    1,
    lines.join("\n"),
  );
});

test("a failing history poll is logged once per summary", async (t) => {
  const { gateway, history, summarise, compact } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  await summarise();
  gateway.historyFails = 1000;
  compact.reject(closed());
  await tick(300);
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.equal(
    lines.filter((l) => /reading the history failed: TIMEOUT/.test(l)).length,
    1,
    lines.join("\n"),
  );
  assert.equal((await history()).compacting, true);
});

test("a throw while recording the end is logged and still frees the chat", async (t) => {
  const { assistants, summarise, compact, free } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => {});
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const unhide = assistants.longChats.unhide;
  assistants.longChats.unhide = () => {
    throw Object.assign(Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" });
  };
  t.after(() => (assistants.longChats.unhide = unhide));
  await summarise();
  compact.resolve({ ok: true, compacted: true });
  await free();
  await tick(100);
  assert.deepEqual(unhandled, []);
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.ok(lines.some((l) => /recording its end failed: SQLITE_BUSY/.test(l)));
});

test("the upper bound frees the chat and says the outcome is unknown", async (t) => {
  const { history, summarise, sends, free } = await fixture(t, { maxMs: 300 });
  t.mock.method(console, "warn", () => {});
  await summarise();
  assert.equal((await history()).compacting, true);
  await free();
  assert.equal((await history()).compactOutcome, "unknown");
  assert.equal(sends().length, 0);
});
