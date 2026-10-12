import test from "node:test";
import assert from "node:assert/strict";
import { codexAuthStatus } from "../fixtures/cli-mcp-shapes.js";
import {
  CliOAuthStatus,
  codexAuthStates,
  loginCommand,
} from "../../server/features/mcp-servers/cli-oauth-status.js";

const accounts = { environment: (id) => ({ HOME: `/home/${id}` }), home: "/home" };
const codex = [{ id: "codex", installed: true, path: "/fake/codex" }];

test("the mapping follows what the Codex contract pinned", () => {
  assert.equal(codexAuthStates[codexAuthStatus.loggedIn], "connected");
  assert.equal(codexAuthStates[codexAuthStatus.loggedOut], "login-required");
});

const listed = (...entries) => ({ stdout: JSON.stringify(entries) });
const quiet = { warn: () => {} };

test("Codex status is read at most every half minute and mapped to three states", async () => {
  const calls = [];
  let now = 0;
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    now: () => now,
    run: async (file, args, options) => {
      calls.push([file, args, options.env.HOME]);
      return listed(
        {
          name: "docs",
          auth_status: codexAuthStatus.loggedIn,
          transport: { http_headers: { A: "value-secret" } },
        },
        { name: "search", auth_status: codexAuthStatus.loggedOut },
        { name: "plain", auth_status: "bearer_token" },
      );
    },
  });
  // A cold start answers "unknown" at once; the read lands in the background.
  assert.deepEqual(await status.codex(), {});
  await status.settled();
  assert.deepEqual(await status.codex(), {
    docs: "connected",
    search: "login-required",
    plain: "unknown",
  });
  now = 31000;
  await status.codex();
  await status.settled();
  const call = ["/fake/codex", ["mcp", "list", "--json"], "/home/local-codex"];
  assert.deepEqual(calls, [call, call]);
});

test("a missing Codex reports nothing", async () => {
  const status = new CliOAuthStatus({ tools: () => [], accounts, ...quiet });
  await status.codex();
  await status.settled();
  assert.deepEqual(await status.codex(), {});
});

test("a failed read keeps the last states and logs its code only", async () => {
  let now = 0;
  const warnings = [];
  const runs = [
    async () => listed({ name: "docs", auth_status: codexAuthStatus.loggedIn }),
    async () => ({ stdout: "not json value-secret" }),
    async () => {
      throw Object.assign(new Error("/private/path value-secret"), { code: "ETIMEDOUT" });
    },
  ];
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    now: () => now,
    warn: (line) => warnings.push(line),
    run: () => runs.shift()(),
  });
  for (const at of [0, 31000, 62000]) {
    now = at;
    await status.codex();
    await status.settled();
    assert.deepEqual(await status.codex(), { docs: "connected" });
  }
  assert.deepEqual(warnings, [
    "Codex MCP login status could not be read (ERROR).",
    "Codex MCP login status could not be read (ETIMEDOUT).",
  ]);
});

test("a slow Codex never holds up a caller and runs once for concurrent calls", async () => {
  let now = 0;
  let runs = 0;
  let finish;
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    now: () => now,
    run: () => {
      runs += 1;
      return new Promise((resolve) => (finish = resolve));
    },
  });
  // Cold start: unknown at once, although Codex has not answered.
  const answers = await Promise.all([status.codex(), status.codex(), status.codex()]);
  assert.deepEqual(answers, [{}, {}, {}]);
  assert.equal(runs, 1);
  finish(listed({ name: "docs", auth_status: codexAuthStatus.loggedIn }));
  await status.settled();
  now = 31000;
  // A refresh is pending: callers get the last states at once, still one run.
  assert.deepEqual(await status.codex(), { docs: "connected" });
  assert.deepEqual(await status.codex(), { docs: "connected" });
  assert.equal(runs, 2);
  finish(listed({ name: "docs", auth_status: codexAuthStatus.loggedOut }));
  await status.settled();
  assert.deepEqual(await status.codex(), { docs: "login-required" });
  assert.equal(runs, 2);
});

test("each CLI's own login command", () => {
  assert.equal(loginCommand("claude", "docs"), "/mcp");
  assert.equal(loginCommand("codex", "docs"), "codex mcp login docs");
  assert.equal(loginCommand("opencode", "docs"), "opencode mcp auth docs");
});

const managed = {
  ...accounts,
  list: () => [
    { id: "local-codex", tool: "codex", kind: "local" },
    { id: "a1", name: "Work", tool: "codex", kind: "managed" },
    { id: "a2", name: "Private", tool: "codex", kind: "managed" },
    { id: "c1", name: "Claude", tool: "claude", kind: "managed" },
  ],
  codexCredentialArgs: (id) =>
    id === "local-codex" ? [] : ["-c", 'mcp_oauth_credentials_store="file"'],
};

test("each managed Codex account is read in its own home with the file store", async () => {
  const calls = [];
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts: managed,
    ...quiet,
    run: async (_file, args, options) => {
      calls.push([options.env.HOME, args]);
      if (options.env.HOME === "/home/a2")
        throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
      return listed({
        name: "docs",
        auth_status: options.env.HOME === "/home/a1" ? "o_auth" : "not_logged_in",
      });
    },
  });
  assert.deepEqual(status.accountStates(), {
    accounts: [
      { id: "a1", name: "Work" },
      { id: "a2", name: "Private" },
    ],
    states: {},
  });
  await status.settled();
  assert.deepEqual(calls, [
    ["/home/local-codex", ["mcp", "list", "--json"]],
    ["/home/a1", ["-c", 'mcp_oauth_credentials_store="file"', "mcp", "list", "--json"]],
    ["/home/a2", ["-c", 'mcp_oauth_credentials_store="file"', "mcp", "list", "--json"]],
  ]);
  assert.deepEqual(await status.codex(), { docs: "login-required" });
  // An account whose read failed stays unknown; the others keep their states.
  assert.deepEqual(status.accountStates().states, { a1: { docs: "connected" } });
});

test("a completed login shows at once and the next list reads again", async () => {
  let now = 0;
  let runs = 0;
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts: managed,
    now: () => now,
    ...quiet,
    run: async () => {
      runs += 1;
      return listed();
    },
  });
  await status.codex();
  await status.settled();
  assert.equal(runs, 3);
  status.mark("a1", "docs", "connected");
  status.invalidate();
  assert.deepEqual(status.accountStates().states.a1, { docs: "connected" });
  now = 1000;
  await status.codex();
  await status.settled();
  assert.equal(runs, 6, "read again before the half minute is over");
});

test("a login marked during a read survives that read's older answer", async () => {
  let finish;
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts: managed,
    ...quiet,
    run: (_file, _args, options) =>
      options.env.HOME === "/home/a1" && !finish
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve(
            options.env.HOME === "/home/a1"
              ? listed({ name: "docs", auth_status: "not_logged_in" })
              : listed(),
          ),
  });
  status.accountStates();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  // The callback marks without waiting for the read in flight.
  status.mark("a1", "docs", "connected");
  status.invalidate();
  finish(listed({ name: "docs", auth_status: "not_logged_in" }));
  await status.settled();
  assert.deepEqual(status.accountStates().states.a1, { docs: "connected" });
  await status.settled();
  // A read that started after the mark is the truth again.
  assert.deepEqual(status.accountStates().states.a1, { docs: "login-required" });
});
