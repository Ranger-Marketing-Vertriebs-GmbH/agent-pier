import test from "node:test";
import assert from "node:assert/strict";
import { CodexMcpLogins } from "../../server/features/mcp-servers/codex-mcp-logins.js";
import { cliOAuthCallback } from "../../server/features/mcp-servers/oauth-redirect.js";
import { fakeCodexLogin } from "../helpers/fake-codex-login.js";

const base = "https://pier.example.ts.net/api/mcp-servers/cli-oauth/callback";
const local = { requestOrigin: "http://127.0.0.1:4380" };

function setup(options = {}) {
  const fake = fakeCodexLogin(options.fake);
  const servers = {
    items: {
      s1: { id: "s1", name: "docs", transport: "http", auth: "oauth" },
      s2: { id: "s2", name: "plain", transport: "http", auth: "headers" },
      s3: { id: "s3", name: "loose", transport: "http", auth: "oauth" },
    },
    get(id) {
      if (!this.items[id]) throw Object.assign(new Error("not found"), { status: 404 });
      return this.items[id];
    },
    bound: ["s1", "s2"],
    bindings(kind, cli) {
      return kind === "cli" && cli === "codex" ? this.bound : [];
    },
  };
  const accounts = {
    home: "/home/owner",
    removed: new Set(),
    get(id) {
      const found = this.removed.has(id)
        ? undefined
        : {
            a1: { id: "a1", name: "Work", tool: "codex", kind: "managed" },
            a2: { id: "a2", name: "Private", tool: "codex", kind: "managed" },
            c1: { id: "c1", name: "Claude", tool: "claude", kind: "managed" },
            "local-codex": { id: "local-codex", tool: "codex", kind: "local" },
          }[id];
      if (!found) throw Object.assign(new Error("not found"), { status: 404 });
      return found;
    },
    environment: (id) => ({ CODEX_HOME: `/data/profiles/${id}/codex` }),
    codexCredentialArgs: () => ["-c", 'mcp_oauth_credentials_store="file"'],
  };
  const timers = [];
  const settled = [];
  const prepared = [];
  const warnings = [];
  const closed = [];
  let now = 0;
  const logins = new CodexMcpLogins({
    accounts,
    servers,
    tools: () => [{ id: "codex", installed: true, path: "/fake/codex" }],
    prepare: async (account) => prepared.push(account.id),
    callbackBase: () => base,
    remoteUrl: () => "https://pier.example.ts.net",
    spawn: fake.spawn,
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    unschedule: (timer) => {
      if (timer) timer.cleared = true;
    },
    onSettled: (event) => settled.push(event),
    onClosed: (event) => closed.push(event),
    warn: (line) => warnings.push(line),
    completeTimeoutMs: 2000,
    ...options.service,
  });
  return {
    logins,
    fake,
    timers,
    settled,
    prepared,
    warnings,
    closed,
    servers,
    accounts,
    advance: (ms) => (now += ms),
  };
}

const callback = (run, query = `code=c-1&state=${run.state}`) =>
  `/api/mcp-servers/cli-oauth/callback/SEGMENT12345?${query}`;

test("a login runs Codex in the account's home with the file store and the callback URL", async () => {
  const { logins, fake, prepared } = setup();
  const started = await logins.start("s1", "a1", local);
  const [run] = fake.runs;
  assert.equal(started.authorizationUrl, run.authorize());
  assert.equal(run.file, "/fake/codex");
  assert.deepEqual(run.args, [
    "-c",
    'mcp_oauth_credentials_store="file"',
    "-c",
    `mcp_oauth_callback_url=${JSON.stringify(base)}`,
    "mcp",
    "login",
    "docs",
    "--no-browser",
  ]);
  assert.equal(run.options.env.CODEX_HOME, "/data/profiles/a1/codex");
  assert.equal(run.options.cwd, "/home/owner");
  assert.deepEqual(prepared, ["a1"]);
  assert.deepEqual(logins.view("s1"), { a1: { pending: true } });
});

test("the callback reaches the login of its state, rebuilt from the callback base", async () => {
  const { logins, fake, settled } = setup();
  await logins.start("s1", "a1", local);
  await logins.start("s1", "a2", local);
  const [first, second] = fake.runs;
  // Both accounts log in to the same server: the same path segment, other states.
  const done = await logins.complete(callback(second));
  assert.deepEqual(done, { serverId: "s1", accountId: "a2", result: "connected" });
  assert.equal(
    second.written,
    `https://pier.example.ts.net${callback(second)}\n`,
    "the full callback URL from the configured origin, one line",
  );
  assert.equal(first.written, "");
  assert.deepEqual(logins.view("s1"), {
    a1: { pending: true },
    a2: { result: "connected" },
  });
  assert.deepEqual(settled, [
    { serverId: "s1", name: "docs", accountId: "a2", result: "connected" },
  ]);
  // Single use: the same state again runs nothing.
  assert.deepEqual(await logins.complete(callback(second)), {
    result: "error",
    reason: "state-invalid",
  });
});

test("an unknown or missing state writes nothing", async () => {
  const { logins, fake } = setup();
  await logins.start("s1", "a1", local);
  for (const query of ["code=x&state=forged", "code=x", "state=a&state=b"])
    assert.deepEqual(
      await logins.complete(`/api/mcp-servers/cli-oauth/callback/SEG?${query}`),
      { result: "error", reason: "state-invalid" },
    );
  assert.equal(fake.runs[0].written, "");
  assert.deepEqual(logins.view("s1"), { a1: { pending: true } });
});

test("a provider error is handed to Codex and reported with its reason", async () => {
  const { logins, fake } = setup();
  await logins.start("s1", "a1", local);
  const [run] = fake.runs;
  const done = await logins.complete(
    callback(run, `error=access_denied&state=${run.state}`),
  );
  assert.deepEqual(done, {
    serverId: "s1",
    accountId: "a1",
    result: "error",
    reason: "access_denied",
  });
  assert.match(run.written, /error=access_denied/);
  const odd = setup();
  await odd.logins.start("s1", "a1", local);
  const [other] = odd.fake.runs;
  assert.equal(
    (await odd.logins.complete(callback(other, `error=weird&state=${other.state}`)))
      .reason,
    "provider-error",
  );
  assert.deepEqual(logins.view("s1"), {
    a1: { result: "error", reason: "access_denied" },
  });
});

test("a code Codex refuses fails without a reason from the provider", async () => {
  const { logins, fake } = setup({
    fake: {
      behave: (run) => {
        run.child.stdout.write(`${run.authorize()}\n`);
        run.child.stdin.removeAllListeners("data");
        run.child.stdin.on("data", () => run.exit(1));
        return true;
      },
    },
  });
  await logins.start("s1", "a1", local);
  const done = await logins.complete(callback(fake.runs[0]));
  assert.equal(done.reason, "cli-failed");
});

test("one pending login per account and server: a new one ends the previous", async () => {
  const { logins, fake } = setup();
  await logins.start("s1", "a1", local);
  await logins.start("s1", "a1", local);
  const [first, second] = fake.runs;
  assert.deepEqual(first.child.signals, ["SIGTERM"]);
  assert.deepEqual(await logins.complete(callback(first)), {
    result: "error",
    reason: "state-invalid",
  });
  assert.equal((await logins.complete(callback(second))).result, "connected");
});

test("a login expires after five minutes and its process is ended", async () => {
  const { logins, fake, timers, advance } = setup();
  await logins.start("s1", "a1", local);
  const [run] = fake.runs;
  const expiry = timers.find((timer) => timer.ms === 5 * 60 * 1000);
  assert.ok(expiry, "an expiry of five minutes");
  advance(5 * 60 * 1000);
  assert.deepEqual(await logins.complete(callback(run)), {
    result: "error",
    reason: "state-invalid",
  });
  expiry.fn();
  assert.deepEqual(run.child.signals, ["SIGTERM"]);
  assert.equal(run.written, "");
});

test("the expiry timer ends a forgotten login", async () => {
  const { logins, fake, timers } = setup();
  await logins.start("s1", "a1", local);
  timers.find((timer) => timer.ms === 5 * 60 * 1000).fn();
  assert.deepEqual(fake.runs[0].child.signals, ["SIGTERM"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logins.view("s1"), { a1: { result: "error", reason: "expired" } });
});

test("Codex giving up on its own reports the login as failed", async () => {
  const { logins, fake } = setup();
  await logins.start("s1", "a1", local);
  fake.runs[0].exit(1);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logins.view("s1"), { a1: { result: "error", reason: "cli-failed" } });
});

test("cancel ends the process and forgets the login", async () => {
  const { logins, fake } = setup();
  await logins.start("s1", "a1", local);
  assert.equal(logins.cancel("s1", "a1"), true);
  assert.deepEqual(fake.runs[0].child.signals, ["SIGTERM"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logins.view("s1"), {});
  assert.equal(logins.cancel("s1", "a1"), false);
});

test("close ends every pending login", async () => {
  const { logins, fake } = setup();
  await logins.start("s1", "a1", local);
  await logins.start("s1", "a2", local);
  logins.close();
  assert.deepEqual(
    fake.runs.map((run) => run.child.signals),
    [["SIGTERM"], ["SIGTERM"]],
  );
});

test("pending logins are capped", async () => {
  const { logins } = setup({ service: { maxPending: 1 } });
  await logins.start("s1", "a1", local);
  await assert.rejects(logins.start("s1", "a2", local), {
    code: "login-limit",
    status: 429,
  });
  // Replacing the account's own login stays possible.
  await logins.start("s1", "a1", local);
});

test("refusals run nothing", async () => {
  const { logins, fake } = setup();
  const refused = async (server, account, origin, code) =>
    assert.rejects(logins.start(server, account, origin), { code });
  await refused("s2", "a1", local, "not-oauth");
  await refused("s3", "a1", local, "not-bound");
  await refused("s1", "local-codex", local, "account-invalid");
  await refused("s1", "c1", local, "account-invalid");
  await refused(
    "s1",
    "a1",
    { requestOrigin: "http://192.168.1.5:4380" },
    "plain-http-remote",
  );
  await refused("s1", "a1", {}, "plain-http-remote");
  await assert.rejects(logins.start("s1", "missing", local), { status: 404 });
  const missing = setup({ service: { tools: () => [] } });
  await assert.rejects(missing.logins.start("s1", "a1", local), { code: "cli-missing" });
  const broken = setup({
    service: {
      prepare: async () => {
        throw new Error("/private/path");
      },
    },
  });
  await assert.rejects(broken.logins.start("s1", "a1", local), {
    code: "prepare-failed",
  });
  assert.equal(fake.runs.length + missing.fake.runs.length + broken.fake.runs.length, 0);
});

test("a Codex that prints no authorization URL fails the start", async () => {
  const { logins, fake } = setup({
    fake: {
      behave: (run) => {
        run.child.stderr.write("Error: No MCP server named 'docs' found.\n");
        run.exit(1);
        return true;
      },
    },
  });
  await assert.rejects(logins.start("s1", "a1", local), {
    code: "cli-failed",
    status: 502,
  });
  assert.equal(fake.runs.length, 1);
  assert.deepEqual(logins.view("s1"), {});
});

test("a redirect that is not AgentPier's callback is refused", async () => {
  const { logins, fake } = setup({
    fake: {
      behave: (run) => {
        run.redirect = "http://127.0.0.1:1455/callback";
        run.child.stdout.write(`${run.authorize()}\n`);
        return true;
      },
    },
  });
  await assert.rejects(logins.start("s1", "a1", local), { code: "cli-failed" });
  assert.deepEqual(fake.runs[0].child.signals, ["SIGTERM"]);
});

test("a hanging completion is ended and reported", async () => {
  const { logins, fake } = setup({
    service: {
      completeTimeoutMs: 20,
      schedule: (fn, ms) => setTimeout(fn, ms),
      unschedule: (timer) => clearTimeout(timer),
    },
    fake: {
      behave: (run) => {
        run.child.stdout.write(`${run.authorize()}\n`);
        run.child.stdin.removeAllListeners("data");
        return true;
      },
    },
  });
  await logins.start("s1", "a1", local);
  const done = await logins.complete(callback(fake.runs[0]));
  assert.equal(done.reason, "cli-timeout");
  assert.deepEqual(fake.runs[0].child.signals, ["SIGTERM"]);
});

test("no warning carries a state, code or URL", async () => {
  const { logins, fake, warnings } = setup({
    fake: {
      behave: (run) => {
        run.child.stdout.write(`${run.authorize()}\n`);
        run.child.stdin.removeAllListeners("data");
        run.child.stdin.on("data", () => run.exit(1));
        return true;
      },
    },
  });
  await logins.start("s1", "a1", local);
  await logins.complete(
    callback(fake.runs[0], `code=c-secret&state=${fake.runs[0].state}`),
  );
  for (const line of warnings) assert.doesNotMatch(line, /state-1|c-secret|https?:/);
});

test("Codex is sent back to the HTTPS remote origin, else to AgentPier's loopback", () => {
  assert.equal(
    cliOAuthCallback({ remoteUrl: "https://pier.example.ts.net:8443/x/", port: 4380 }),
    "https://pier.example.ts.net:8443/api/mcp-servers/cli-oauth/callback",
  );
  for (const remoteUrl of [null, "http://192.168.1.5:4380", "nonsense"])
    assert.equal(
      cliOAuthCallback({ remoteUrl, port: 4391 }),
      "http://127.0.0.1:4391/api/mcp-servers/cli-oauth/callback",
    );
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** A Codex that never prints its URL (a start still in flight). */
const silent = { behave: () => true };

test("a login still starting counts toward the cap and is ended by cancel and close", async () => {
  const { logins, fake } = setup({ service: { maxPending: 1 }, fake: silent });
  const first = logins.start("s1", "a1", local);
  await tick();
  await assert.rejects(logins.start("s1", "a2", local), { code: "login-limit" });
  assert.deepEqual(logins.view("s1"), { a1: { pending: true } });
  assert.equal(logins.cancel("s1", "a1"), true);
  await assert.rejects(first, { code: "login-ended" });
  assert.deepEqual(fake.runs[0].child.signals, ["SIGTERM"]);
  const second = logins.start("s1", "a2", local);
  await tick();
  logins.close();
  await assert.rejects(second, { code: "login-ended" });
  assert.deepEqual(fake.runs[1].child.signals, ["SIGTERM"]);
  assert.deepEqual(logins.view("s1"), {});
});

test("a cancel while the account is prepared runs no Codex", async () => {
  let release;
  const { logins, fake } = setup({
    service: { prepare: () => new Promise((resolve) => (release = resolve)) },
  });
  const started = logins.start("s1", "a1", local);
  logins.cancel("s1", "a1");
  release();
  await assert.rejects(started, { code: "login-ended" });
  assert.equal(fake.runs.length, 0);
});

test("a Codex that exits right after printing its URL fails the login", async () => {
  const { logins, closed } = setup({
    fake: {
      behave: (run) => {
        run.child.stdout.write(`${run.authorize()}\n`);
        run.exit(1);
        return true;
      },
    },
  });
  await logins.start("s1", "a1", local);
  await tick();
  await tick();
  assert.deepEqual(logins.view("s1"), { a1: { result: "error", reason: "cli-failed" } });
  assert.deepEqual(closed, [{ serverId: "s1", accountId: "a1", reason: "cli-failed" }]);
});

test("logins that end without a callback are reported for the audit", async () => {
  const { logins, timers, closed } = setup();
  await logins.start("s1", "a1", local);
  await logins.start("s1", "a1", local);
  timers
    .filter((timer) => timer.ms === 5 * 60 * 1000)
    .at(-1)
    .fn();
  logins.cancel("s1", "a2");
  assert.deepEqual(closed, [
    { serverId: "s1", accountId: "a1", reason: "replaced" },
    { serverId: "s1", accountId: "a1", reason: "expired" },
  ]);
});

test("a removed account or an unbound, renamed or deleted server ends its logins", async () => {
  const { logins, fake, servers, accounts, closed } = setup();
  await logins.start("s1", "a1", local);
  await logins.start("s1", "a2", local);
  logins.prune();
  assert.equal(closed.length, 0, "nothing changed");
  accounts.removed.add("a1");
  logins.prune();
  assert.deepEqual(fake.runs[0].child.signals, ["SIGTERM"]);
  assert.deepEqual(closed, [{ serverId: "s1", accountId: "a1", reason: "obsolete" }]);
  servers.items.s1 = { ...servers.items.s1, name: "renamed" };
  logins.prune();
  assert.deepEqual(fake.runs[1].child.signals, ["SIGTERM"]);
  assert.deepEqual(logins.view("s1"), {});
  servers.items.s1 = { ...servers.items.s1, name: "docs" };
  await logins.start("s1", "a2", local);
  servers.bound = ["s2"];
  logins.prune();
  assert.deepEqual(fake.runs[2].child.signals, ["SIGTERM"]);
});

test("a process that ignores SIGTERM is killed after a grace period", async () => {
  const { logins, fake, timers } = setup({ service: { killGraceMs: 2000 } });
  await logins.start("s1", "a1", local);
  const [run] = fake.runs;
  run.child.kill = (signal) => run.child.signals.push(signal);
  logins.cancel("s1", "a1");
  timers.find((timer) => timer.ms === 2000 && !timer.cleared).fn();
  assert.deepEqual(run.child.signals, ["SIGTERM", "SIGKILL"]);
});
