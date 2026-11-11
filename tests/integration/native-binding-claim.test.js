import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  NativeSessionBinding,
  claimNativeSession,
  recordNativeSession,
  runNativeSessionHook,
} from "../../server/features/sessions/native-session-binding.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { nativePushValue } from "../../server/features/requests/native-push.js";
import { readerTui } from "../../server/features/sessions/native-session-opencode.js";
import { pidStart } from "../../vendor/agentbus/core/proc.js";
import { until } from "../helpers/adapter-process.js";

// What a sandbox that denies `ps` leaves a hook: no process can be read, its own
// included.
const denied = () => null;

/**
 * A session with its binding and request launch, a broker wired like services.js, and
 * a stand-in for the server's reading of the process list (`runtime`): the pid the
 * hook claims belongs to the session's pane and this is the CLI above it.
 */
async function fixture(t, { tool = "claude" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-claim-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  const account = accounts.create({ name: "one", tool });
  const session = { id: "one", tool, accountId: account.id, cwd, status: "running" };
  const sessions = { get: async () => ({ ...session }) };
  const claims = [];
  const state = { runtime: { pid: process.pid, pidStart: pidStart(process.pid) } };
  const bindings = new NativeSessionBinding({
    dataDir: accounts.dataDir,
    accounts,
    sessions,
    processOptions: {
      resolveRuntime: async (input) => {
        claims.push(input.claimedPid);
        if (!state.runtime) throw Error("not in this session's pane");
        return state.runtime;
      },
    },
  });
  const broker = new RequestBroker({
    dataDir: accounts.dataDir,
    sessions,
    onNative: (sessionId, push) =>
      push.type === "binding" ? bindings.claim(sessionId, push) : undefined,
  });
  await broker.ready;
  t.after(() => broker.close());
  const input = { id: "one", account, cwd };
  let launch = { command: process.execPath, args: [], env: {}, cliVersion: "2.1.322" };
  launch = await bindings.prepare({ ...input, launch });
  launch = await broker.prepare({ ...input, launch });
  Object.assign(session, {
    nativeBinding: launch.nativeBinding,
    nativeRequests: launch.nativeRequests,
  });
  return { bindings, session, env: launch.env, claims, state, cwd };
}

test("a hook that cannot read the process list says so, apart from a stopped CLI", async (t) => {
  const f = await fixture(t);
  const data = { session_id: "native-one", cwd: f.cwd };
  assert.throws(
    () => recordNativeSession(data, f.env, { ps: denied }),
    (error) => error.processUnreadable === true,
  );
  // The hook's own process is listed, the CLI's is not: the CLI has ended.
  assert.throws(
    () =>
      recordNativeSession(data, f.env, {
        pid: 2 ** 22 + 7,
        ps: (pid) => (pid === process.pid ? "now" : null),
      }),
    (error) => !error.processUnreadable,
  );
  assert.equal(f.bindings.verifiedReceipt(f.session), null);
});

test("the server writes the receipt for a hook that cannot read the process list", async (t) => {
  const f = await fixture(t);
  const payload = { hook_event_name: "SessionStart", session_id: "native-one" };
  await runNativeSessionHook({
    env: f.env,
    input: Readable.from([JSON.stringify({ ...payload, cwd: f.cwd })]),
    ps: denied,
  });
  // The hook claims its own process; the server names the CLI and its start.
  assert.deepEqual(f.claims, [process.pid]);
  const receipt = f.bindings.verifiedReceipt(f.session);
  assert.equal(receipt.providerSessionId, "native-one");
  assert.equal(receipt.pid, f.state.runtime.pid);
  assert.equal(receipt.pidStart, f.state.runtime.pidStart);
  assert.deepEqual(await f.bindings.resolve(f.session), {
    id: "native-one",
    updatedAt: receipt.updatedAt,
  });
});

test("a claim proves the same as a receipt: token, project, pane and one live CLI", async (t) => {
  const f = await fixture(t);
  const data = { session_id: "native-one", cwd: f.cwd };
  const refused = async (change, env = f.env) => {
    assert.equal(await claimNativeSession({ ...data, ...change }, env), false);
    assert.equal(f.bindings.verifiedReceipt(f.session), null);
  };
  await refused({}, { ...f.env, AGENTPIER_NATIVE_BINDING_TOKEN: "0".repeat(48) });
  await refused({ cwd: os.tmpdir() });
  await refused({ session_id: "../escape" });
  // The claimed process is not below the session's pane.
  const runtime = f.state.runtime;
  f.state.runtime = null;
  await refused({});
  // The CLI the server found was replaced before the receipt was written.
  f.state.runtime = { ...runtime, pidStart: "Thu Jan  1 00:00:00 1970" };
  await refused({});
  f.state.runtime = runtime;
  assert.equal(await claimNativeSession(data, f.env), true);
  // Another live CLI (a nested one) cannot take the binding over.
  f.state.runtime = { pid: process.ppid, pidStart: pidStart(process.ppid) };
  assert.equal(await claimNativeSession({ ...data, session_id: "nested" }, f.env), false);
  assert.equal(f.bindings.verifiedReceipt(f.session).providerSessionId, "native-one");
  // Without a request channel there is no server to ask.
  assert.equal(
    await claimNativeSession(data, { ...f.env, AGENTPIER_REQUEST_FILE: "" }),
    false,
  );
});

test("a binding claim is validated before it reaches the server's handler", () => {
  const claim = {
    type: "binding",
    token: "a".repeat(48),
    providerSessionId: "native-one",
    cwd: "/project",
    pid: 4242,
    extra: "dropped",
  };
  const { extra: _extra, ...clean } = claim;
  assert.deepEqual(nativePushValue(claim), clean);
  assert.deepEqual(nativePushValue({ ...claim, providerSessionId: null, cwd: null }), {
    ...clean,
    providerSessionId: null,
    cwd: null,
  });
  for (const change of [
    { pid: 1 },
    { pid: "4242" },
    { token: "" },
    { token: 7 },
    { providerSessionId: 7 },
    { cwd: "x".repeat(5000) },
  ])
    assert.throws(() => nativePushValue({ ...claim, ...change }), /Invalid native push/);
});

test("the OpenCode plugin asks the server when it cannot read its own process", async (t) => {
  const f = await fixture(t, { tool: "opencode" });
  let dispose;
  const api = {
    route: { current: { name: "session", params: { sessionID: "ses_one" } } },
    lifecycle: { onDispose: (fn) => (dispose = fn) },
  };
  await readerTui({ channel: () => null, env: f.env, ps: denied })(api);
  t.after(() => dispose());
  await until(() => f.bindings.verifiedReceipt(f.session));
  assert.equal(f.bindings.verifiedReceipt(f.session).providerSessionId, "ses_one");
  // The plugin runs in the CLI's own process, which is what it claims.
  assert.deepEqual(f.claims, [process.pid]);
});
