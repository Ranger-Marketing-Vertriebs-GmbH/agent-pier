import test from "node:test";
import assert from "node:assert/strict";
import { createReloadLifecycle } from "../../server/application/session-reload-lifecycle.js";

function fixture() {
  const calls = [];
  const account = { id: "account", tool: "claude" };
  const session = {
    id: "session",
    status: "running",
    tool: "claude",
    accountId: "account",
    cwd: "/tmp",
    nativeModelId: "claude-sonnet-4-6",
    attachments: { directory: "/tmp/attachments" },
    agentbus: { enabled: false },
    reload: { mode: "now", interrupt: true },
  };
  const services = {
    accounts: {
      get: () => account,
      command: (_id, _tools, _login, _mode, opts) => {
        calls.push(["command", opts]);
        return { command: "/bin/sh", args: ["--model", opts.modelId], env: {} };
      },
    },
    tools: () => [{ id: "claude", path: "/bin/sh", installed: true }],
    history: {
      read: async (_session, id) => {
        assert.equal(id, "native-exact");
        return { observability: { context: { modelId: "claude-opus-4-6" } } };
      },
    },
    models: { read: async () => ({ currentModel: "Opus 4.6" }) },
    sessions: {
      replace: async (_id, fn) => {
        calls.push(["stop"]);
        return fn(session);
      },
    },
  };
  for (const key of [
    "github",
    "agentbus",
    "memoryIntegration",
    "bindings",
    "requests",
    "sshIntegration",
  ])
    services[key] = {
      prepare: async (input) => {
        calls.push([key, input]);
        return input.launch;
      },
      discard: async () => {
        calls.push([key + " discard"]);
      },
    };
  return { ...createReloadLifecycle(services), services, calls, session };
}
test("reload preflight verifies exact native history and keeps current model; restart rotates all integrations after stop", async () => {
  const f = fixture();
  const plan = await f.prepareReload(f.session, "native-exact");
  assert.equal(
    f.calls.some(([name]) => name === "stop"),
    false,
  );
  assert.equal(plan.launch.args.includes("claude-opus-4-6"), true);
  const launch = await f.restartReload(f.session, plan);
  assert.equal(launch.args.includes("--session-id"), false);
  assert.deepEqual(launch.args.slice(-4), [
    "--add-dir",
    "/tmp/attachments",
    "--resume",
    "native-exact",
  ]);
  assert.equal(f.calls.find(([key]) => key === "agentbus")[1].enabled, false);
  assert.equal(f.calls.find(([key]) => key === "bindings")[1].replace, true);
  assert.ok(
    f.calls.findIndex(([key]) => key === "stop") <
      f.calls.findIndex(([key]) => key === "sshIntegration"),
  );
});
test("history failure cannot stop a running process", async () => {
  const f = fixture();
  f.services.history.read = async () => {
    throw Error("unavailable");
  };
  await assert.rejects(f.prepareReload(f.session, "native-exact"));
  assert.equal(f.calls.length, 0);
});

test("changing the native conversation after preflight leaves the old process untouched", async () => {
  const f = fixture();
  f.services.bindings.resolve = async () => ({ id: "different-native" });
  f.services.sessions.replace = async (_id, _prepare, beforeStop) => {
    await beforeStop({ ...f.session, status: "running" }, async () => "");
    assert.fail("Must not reach process stop");
  };
  const plan = await f.prepareReload(f.session, "native-exact");
  await assert.rejects(f.restartReload(f.session, plan), /conversation changed/);
  assert.equal(
    f.calls.some(([key]) => key.endsWith("discard")),
    false,
  );
});

test("a live model display name cannot silently fall back to the old history model", async () => {
  const f = fixture();
  f.services.history.read = async () => ({
    observability: { context: { modelId: "claude-sonnet-4-6" } },
  });
  await assert.rejects(
    f.prepareReload(f.session, "native-exact"),
    /model.*preserv|preserv.*model/i,
  );
  assert.equal(
    f.calls.some(([key]) => key === "stop"),
    false,
  );
});

test("a model change after preflight leaves the running process untouched", async () => {
  const f = fixture();
  f.services.bindings.resolve = async () => ({ id: "native-exact" });
  f.services.sessions.replace = async (_id, _prepare, beforeStop) => {
    await beforeStop(f.session, async () => "Sonnet 4.6 · Claude API");
    assert.fail("Must not reach process stop");
  };
  const plan = await f.prepareReload(f.session, "native-exact");
  await assert.rejects(f.restartReload(f.session, plan), /model changed/);
  assert.equal(
    f.calls.some(([key]) => key.endsWith("discard")),
    false,
  );
});

test("Codex reload launches the displayed exact model with its explicit reasoning effort", async () => {
  const f = fixture();
  f.session.tool = "codex";
  f.services.accounts.get().tool = "codex";
  f.services.models.read = async () => ({ currentModel: "gpt-6 high effort" });
  const plan = await f.prepareReload(f.session, "native-exact");
  assert.deepEqual(plan.launch.args.slice(0, 4), [
    "--model",
    "gpt-6",
    "-c",
    'model_reasoning_effort="high"',
  ]);
  assert.deepEqual(plan.launch.args.slice(-2), ["resume", "native-exact"]);
});

test("Codex reload preserves attachment roots with a writable sandbox except in YOLO mode", async () => {
  for (const launchMode of ["default", "yolo"]) {
    const f = fixture();
    f.session.tool = "codex";
    f.session.launchMode = launchMode;
    f.services.accounts.get().tool = "codex";
    f.services.models.read = async () => ({ currentModel: "gpt-6" });
    f.services.accounts.command = (_id, _binaries, _login, mode) => ({
      command: "/bin/sh",
      args: mode === "yolo" ? ["--yolo"] : [],
      env: {},
      launchMode: mode,
    });
    const { launch } = await f.prepareReload(f.session, "native-exact");
    const directoryIndex = launch.args.indexOf("--add-dir");
    assert.equal(launch.args[directoryIndex + 1], f.session.attachments.directory);
    assert.equal(
      launch.args.includes('sandbox_mode="workspace-write"'),
      launchMode === "default",
    );
    assert.equal(launch.args.includes("--yolo"), launchMode === "yolo");
    assert.deepEqual(launch.args.slice(-2), ["resume", "native-exact"]);
  }
});
