import test from "node:test";
import assert from "node:assert/strict";
import { SessionAutoResume } from "../../server/features/sessions/session-auto-resume.js";

const at = (minute) => `2026-10-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const interrupted = (id, minute, extra = {}) => ({
  id,
  tool: "claude",
  status: "stopped",
  interruption: { cause: "tmux-server-lost", at: at(minute), resume: "pending" },
  ...extra,
});

function fixture(list, { status = {}, request, enabled = () => true } = {}) {
  const store = new Map(list.map((session) => [session.id, structuredClone(session)]));
  const calls = [];
  const audit = [];
  let active = 0;
  let maxActive = 0;
  const complete = (session) => {
    session.status = "running";
    delete session.interruption;
    return { state: "completed" };
  };
  const services = {
    sessions: {
      list: async () => [...store.values()].map((session) => structuredClone(session)),
      get: async (id) => {
        if (!store.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
        return structuredClone(store.get(id));
      },
      setInterruption: async (id, value) => {
        const session = store.get(id);
        if (value) session.interruption = value;
        else delete session.interruption;
        return structuredClone(session);
      },
    },
    reload: {
      status: async (id) => ({
        eligible: true,
        reason: null,
        state: store.get(id).reloadState || "idle",
        ...status[id],
      }),
      request: async (id, body) => {
        calls.push({ id, body, started: store.get(id).interruption?.resume });
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return request ? request(store.get(id)) : complete(store.get(id));
      },
    },
    audit: { append: (event) => audit.push(event) },
  };
  const resume = new SessionAutoResume({ services, enabled, timeoutMs: 30, pollMs: 1 });
  return { resume, store, calls, audit, maxActive: () => maxActive };
}

test("pending interruptions resume oldest first, one at a time, with a fresh request", async () => {
  const { resume, store, calls, audit, maxActive } = fixture([
    interrupted("late", 5),
    interrupted("early", 1),
  ]);
  await resume.initialize();
  assert.deepEqual(
    calls.map((call) => call.id),
    ["early", "late"],
  );
  assert.equal(maxActive(), 1);
  for (const call of calls) {
    assert.equal(call.body.mode, "now");
    assert.match(call.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(call.started, "started");
  }
  assert.equal(store.get("early").status, "running");
  assert.equal(store.get("early").interruption, undefined);
  assert.deepEqual(
    audit.map((event) => [
      event.action,
      event.outcome,
      event.sessionId,
      event.details.tool,
    ]),
    [
      ["session.restored", "success", "early", "claude"],
      ["session.restored", "success", "late", "claude"],
    ],
  );
});

test("only pending interruptions of stopped sessions are resumed", async () => {
  const { resume, calls } = fixture([
    { id: "plain-stop", tool: "claude", status: "stopped" },
    interrupted("running", 1, { status: "running" }),
    interrupted("failed-before", 2, {
      interruption: { cause: "tmux-server-lost", at: at(2), resume: "failed" },
    }),
  ]);
  await resume.initialize();
  assert.deepEqual(calls, []);
});

test("an attempt cut off by a restart is not repeated", async () => {
  const { resume, store, calls, audit } = fixture([
    interrupted("cut-off", 1, {
      interruption: { cause: "tmux-server-lost", at: at(1), resume: "started" },
    }),
  ]);
  await resume.initialize();
  assert.deepEqual(calls, []);
  assert.equal(store.get("cut-off").interruption.resume, "failed");
  assert.equal(store.get("cut-off").interruption.reason, "attempt-interrupted");
  assert.equal(audit[0].outcome, "failure");
});

test("ineligible sessions are skipped with the reload reason", async () => {
  const { resume, store, calls } = fixture([interrupted("pipeline", 1)], {
    status: { pipeline: { eligible: false, reason: "unsupported-session" } },
  });
  await resume.initialize();
  assert.deepEqual(calls, []);
  assert.equal(store.get("pipeline").interruption.resume, "skipped");
  assert.equal(store.get("pipeline").interruption.reason, "unsupported-session");
});

test("preparation errors, failed reloads and timeouts are recorded as failures", async () => {
  const cases = [
    [() => Promise.reject(new Error("binary missing")), "prepare-failed"],
    [() => ({ state: "failed" }), "reload-failed"],
    [
      (session) => {
        session.reloadState = "reloading";
        return { state: "reloading" };
      },
      "timeout",
    ],
  ];
  for (const [request, reason] of cases) {
    const { resume, store, audit } = fixture([interrupted("broken", 1)], { request });
    await resume.initialize();
    assert.equal(store.get("broken").interruption.resume, "failed");
    assert.equal(store.get("broken").interruption.reason, reason);
    assert.equal(audit.at(-1).outcome, "failure");
  }
});

test("disabled setting leaves interruptions pending until it is enabled", async () => {
  let enabled = false;
  const { resume, store, calls } = fixture([interrupted("waiting", 1)], {
    enabled: () => enabled,
  });
  await resume.initialize();
  assert.deepEqual(calls, []);
  assert.equal(store.get("waiting").interruption.resume, "pending");
  enabled = true;
  await resume.notify();
  assert.deepEqual(
    calls.map((call) => call.id),
    ["waiting"],
  );
});

test("concurrent notifications resume each session once", async () => {
  const { resume, calls } = fixture([interrupted("once", 1)]);
  await Promise.all([resume.notify(), resume.notify(), resume.notify()]);
  assert.deepEqual(
    calls.map((call) => call.id),
    ["once"],
  );
});

test("closing stops further resumes", async () => {
  const { resume, calls } = fixture([interrupted("one", 1), interrupted("two", 2)]);
  await resume.close();
  await resume.notify();
  assert.deepEqual(calls, []);
});

test("an error while preparing one session does not stop the others", async () => {
  const { resume, store, calls, audit } = fixture([
    interrupted("first", 1),
    interrupted("second", 2),
  ]);
  const original = resume.services.reload.status;
  resume.services.reload.status = async (id) => {
    if (id === "first") throw new Error("history unreadable");
    return original(id);
  };
  await resume.initialize();
  assert.deepEqual(
    calls.map((call) => call.id),
    ["second"],
  );
  assert.equal(store.get("first").interruption.resume, "failed");
  assert.equal(store.get("first").interruption.reason, "prepare-failed");
  assert.deepEqual(
    audit.map((event) => [event.sessionId, event.outcome]),
    [
      ["first", "failure"],
      ["second", "success"],
    ],
  );
});

test("a failing startup sweep rejects initialize without unhandled rejections", async () => {
  const { resume, calls } = fixture([interrupted("later", 1)]);
  const list = resume.services.sessions.list;
  let first = true;
  resume.services.sessions.list = async () => {
    if (first) {
      first = false;
      throw new Error("store unreadable");
    }
    return list();
  };
  const unhandled = [];
  const spy = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", spy);
  try {
    await assert.rejects(resume.initialize(), /store unreadable/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await resume.notify();
    assert.deepEqual(
      calls.map((call) => call.id),
      ["later"],
    );
  } finally {
    process.off("unhandledRejection", spy);
  }
});

test("a sweep and a notification never overlap", async () => {
  const { resume, store, calls } = fixture([interrupted("live", 1)]);
  const initializing = resume.initialize();
  const notifying = resume.notify();
  await Promise.all([initializing, notifying]);
  assert.deepEqual(
    calls.map((call) => call.id),
    ["live"],
  );
  assert.equal(store.get("live").interruption, undefined);
});

test("a failed attempt does not overwrite a marker cleared during the attempt", async () => {
  const { resume, store } = fixture([interrupted("stopped", 1)], {
    request: (session) => {
      delete session.interruption;
      return { state: "failed" };
    },
  });
  await resume.initialize();
  assert.equal(store.get("stopped").interruption, undefined);
});
