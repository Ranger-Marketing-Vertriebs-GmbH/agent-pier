import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SessionReload } from "../../server/features/sessions/session-reload.js";
import { resumeLaunch } from "../../server/application/session-reload-launch.js";

function fixture() {
  let session = { id: "session", tool: "codex", status: "running" };
  let activity = "idle",
    nativeId = "native-exact",
    stops = 0,
    preflightError;
  const services = {
    sessions: {
      get: async () => structuredClone(session),
      list: async () => [structuredClone(session)],
      updateReload: async (_id, reload) => {
        session.reload = reload;
      },
    },
    activity: { read: async () => ({ state: activity }), remove() {} },
    bindings: { resolve: async () => (nativeId ? { id: nativeId } : null) },
    prepareReload: async (_session, id) => {
      if (preflightError) throw preflightError;
      return { nativeId: id };
    },
    restartReload: async (_session, plan) => {
      session.reload.replacementStarted = true;
      stops++;
      assert.equal(plan.nativeId, "native-exact");
    },
  };
  const reload = new SessionReload({ services, pollMs: 0 });
  return {
    reload,
    services,
    get stops() {
      return stops;
    },
    get session() {
      return session;
    },
    activity: (value) => {
      activity = value;
    },
    native: (value) => {
      nativeId = value;
    },
    fail: (value) => {
      preflightError = value;
    },
  };
}

test("resume commands use only the exact native conversation", () => {
  for (const [tool, expected] of [
    ["codex", ["resume", "native-exact"]],
    ["claude", ["--resume", "native-exact"]],
    ["opencode", ["--session", "native-exact"]],
  ]) {
    const result = resumeLaunch(
      tool,
      { args: ["--model", "chosen"], env: {} },
      "native-exact",
    );
    assert.deepEqual(result.args, ["--model", "chosen", ...expected]);
    assert.equal(result.args.includes("--session-id"), false);
  }
});
test("unverified native conversation never restarts; preflight failure leaves process untouched", async () => {
  const f = fixture();
  f.native(null);
  assert.equal((await f.reload.status("session")).eligible, false);
  await assert.rejects(
    f.reload.request("session", { mode: "now", requestId: randomUUID() }),
  );
  f.native("native-exact");
  f.fail(Error("secret preflight error"));
  await assert.rejects(
    f.reload.request("session", { mode: "now", requestId: randomUUID() }),
  );
  assert.equal(f.stops, 0);
});
test("duplicate requests restart once including after completion", async () => {
  const f = fixture();
  const body = { mode: "now", requestId: randomUUID() };
  await Promise.all([
    f.reload.request("session", body),
    f.reload.request("session", body),
  ]);
  await f.reload.request("session", body);
  assert.equal(f.stops, 1);
  assert.equal((await f.reload.status("session")).state, "completed");
});
test("busy reload requires acknowledgement; queued work waits for confirmed idle and cancels", async () => {
  const f = fixture();
  f.activity("busy");
  await assert.rejects(
    f.reload.request("session", { mode: "now", requestId: randomUUID() }),
  );
  await f.reload.request("session", { mode: "when-idle", requestId: randomUUID() });
  await f.reload.poll();
  assert.equal(f.stops, 0);
  await f.reload.cancel("session");
  f.activity("idle");
  await f.reload.poll();
  assert.equal(f.stops, 0);
  f.activity("unknown");
  await f.reload.request("session", { mode: "when-idle", requestId: randomUUID() });
  await f.reload.poll();
  assert.equal(f.stops, 0);
  f.activity("idle");
  await f.reload.poll();
  assert.equal(f.stops, 1);
});
test("restart failure and server recovery retain exact identity without automatic replay", async () => {
  const f = fixture();
  f.services.restartReload = async () => {
    f.session.reload.replacementStarted = true;
    throw Error("token=private");
  };
  await f.reload.request("session", { mode: "now", requestId: randomUUID() });
  assert.equal(f.session.reload.state, "failed");
  assert.equal(f.session.reload.nativeId, "native-exact");
  assert.equal(f.session.reload.error.includes("private"), false);
  f.native(null);
  f.session.status = "stopped";
  f.session.reload.state = "reloading";
  const recovered = new SessionReload({ services: f.services, pollMs: 0 });
  await recovered.initialize();
  assert.equal((await recovered.status("session")).state, "failed");
  assert.equal((await recovered.status("session")).nativeId, "native-exact");
});

test("an exited resumed CLI is failed, not completed, and remains exactly recoverable", async () => {
  const f = fixture();
  f.services.restartReload = async () => {
    f.session.reload.replacementStarted = true;
    f.session.status = "stopped";
    f.native(null);
  };
  const result = await f.reload.request("session", {
    mode: "now",
    requestId: randomUUID(),
  });
  assert.equal(result.state, "failed");
  assert.equal(result.nativeId, "native-exact");
  assert.equal(result.eligible, true);
});

test("a resumed CLI with a different native binding cannot complete the request", async () => {
  const f = fixture();
  f.services.restartReload = async () => {
    f.session.reload.replacementStarted = true;
    f.native("wrong-native");
  };
  const result = await f.reload.request("session", {
    mode: "now",
    requestId: randomUUID(),
  });
  assert.equal(result.state, "failed");
  assert.equal(f.session.reload.nativeId, "native-exact");
  assert.equal(result.nativeId, "native-exact");
});

test("polling an empty queue does not inspect unrelated sessions", async () => {
  const f = fixture();
  f.services.sessions.list = async () => {
    throw Error("Unexpected session enumeration");
  };
  await f.reload.poll();
});

test("a pre-stop identity failure cannot grant stale conversation recovery on retry", async () => {
  const f = fixture();
  f.services.restartReload = async () => {
    f.native("new-native");
    throw Error("Conversation changed before stop");
  };
  await f.reload.request("session", { mode: "now", requestId: randomUUID() });
  assert.equal((await f.reload.status("session")).nativeId, "new-native");
  let retriedNative;
  f.services.prepareReload = async (_session, nativeId) => {
    retriedNative = nativeId;
    throw Error("Preflight only");
  };
  await assert.rejects(
    f.reload.request("session", { mode: "now", requestId: randomUUID() }),
  );
  assert.equal(retriedNative, "new-native");
});

test("server recovery before process stop re-verifies the live conversation", async () => {
  const f = fixture();
  f.session.reload = {
    state: "reloading",
    nativeId: "old-native",
    replacementStarted: false,
  };
  await f.reload.initialize();
  assert.equal((await f.reload.status("session")).nativeId, "native-exact");
  f.native(null);
  assert.equal((await f.reload.status("session")).eligible, false);
  f.session.status = "stopped";
  assert.equal((await f.reload.status("session")).nativeId, "old-native");
});

test("queued account switch retains its target across service restart", async () => {
  const f = fixture();
  f.activity("busy");
  const targets = [];
  f.services.prepareReload = async (_session, nativeId, targetAccountId) => {
    targets.push(targetAccountId);
    return { nativeId };
  };
  await f.reload.request("session", {
    mode: "when-idle",
    requestId: randomUUID(),
    targetAccountId: "second",
  });
  assert.equal(f.session.reload.targetAccountId, "second");
  const recovered = new SessionReload({ services: f.services, pollMs: 0 });
  await recovered.initialize();
  f.activity("idle");
  await recovered.poll();
  assert.deepEqual(targets, ["second", "second"]);
});

test("delayed hook approval stays pending and later completes without another restart", async () => {
  const f = fixture();
  f.reload.readinessMs = 0;
  f.services.restartReload = async () => {
    f.session.reload.replacementStarted = true;
    f.native(null);
  };
  const result = await f.reload.request("session", {
    mode: "now",
    requestId: randomUUID(),
  });
  assert.equal(result.state, "reloading");
  await assert.rejects(f.reload.cancel("session"), { status: 409 });
  await f.reload.poll();
  assert.equal(f.session.reload.state, "reloading");
  f.native("native-exact");
  await f.reload.poll();
  assert.equal(f.session.reload.state, "completed");
  assert.equal(f.session.reload.error, null);
  assert.equal(f.stops, 0);
});

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: old failed reload is reconciled only for the running target conversation and account`, async () => {
    const f = fixture();
    f.session.tool = tool;
    f.session.accountId = "original";
    f.session.reload = {
      state: "failed",
      replacementStarted: true,
      nativeId: "native-exact",
      targetAccountId: "target",
      error: "old failure",
    };
    await f.reload.initialize();
    await f.reload.poll();
    assert.equal(f.session.reload.state, "failed");
    f.session.accountId = "target";
    f.native(null);
    await f.reload.poll();
    assert.equal(f.session.reload.state, "failed");
    f.native("native-exact");
    await f.reload.poll();
    assert.equal(f.session.reload.state, "completed");
    assert.equal(f.stops, 0);
  });
}

test("a delayed replacement that exits fails without replay", async () => {
  const f = fixture();
  f.session.reload = {
    state: "reloading",
    replacementStarted: true,
    nativeId: "native-exact",
  };
  f.native(null);
  await f.reload.initialize();
  assert.equal(f.session.reload.state, "reloading");
  f.session.status = "stopped";
  await f.reload.poll();
  assert.equal(f.session.reload.state, "failed");
  assert.equal(f.stops, 0);
});
