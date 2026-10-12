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

test("Codex status is read at most every half minute and mapped to three states", async () => {
  const calls = [];
  let now = 0;
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    now: () => now,
    run: async (file, args, options) => {
      calls.push([file, args, options.env.HOME]);
      return {
        stdout: JSON.stringify([
          {
            name: "docs",
            auth_status: codexAuthStatus.loggedIn,
            transport: { http_headers: { A: "value-secret" } },
          },
          { name: "search", auth_status: codexAuthStatus.loggedOut },
          { name: "plain", auth_status: "bearer_token" },
        ]),
      };
    },
  });
  assert.deepEqual(await status.codex(), {
    docs: "connected",
    search: "login-required",
    plain: "unknown",
  });
  await status.codex();
  now = 31000;
  await status.codex();
  const call = ["/fake/codex", ["mcp", "list", "--json"], "/home/local-codex"];
  assert.deepEqual(calls, [call, call]);
});

test("a missing or failing Codex reports nothing", async () => {
  assert.deepEqual(await new CliOAuthStatus({ tools: () => [], accounts }).codex(), {});
  const failing = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    run: async () => ({ stdout: "not json" }),
  });
  assert.deepEqual(await failing.codex(), {});
  const throwing = new CliOAuthStatus({
    tools: () => {
      throw new Error("no tools");
    },
    accounts,
  });
  assert.deepEqual(await throwing.codex(), {});
});

test("a slow Codex never holds up the caller; its answer is used once it arrives", async () => {
  let now = 0;
  let finish;
  const runs = [
    async () => ({
      stdout: JSON.stringify([{ name: "docs", auth_status: codexAuthStatus.loggedIn }]),
    }),
    () => new Promise((resolve) => (finish = resolve)),
  ];
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    now: () => now,
    wait: 20,
    run: () => runs.shift()(),
  });
  assert.deepEqual(await status.codex(), { docs: "connected" });
  now = 31000;
  const started = Date.now();
  // The refresh hangs: the last known answer comes back after the bounded wait.
  assert.deepEqual(await status.codex(), { docs: "connected" });
  assert.ok(Date.now() - started < 1000);
  finish({
    stdout: JSON.stringify([{ name: "docs", auth_status: codexAuthStatus.loggedOut }]),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await status.codex(), { docs: "login-required" });
});

test("each CLI's own login command", () => {
  assert.equal(loginCommand("claude", "docs"), "/mcp");
  assert.equal(loginCommand("codex", "docs"), "codex mcp login docs");
  assert.equal(loginCommand("opencode", "docs"), "opencode mcp auth docs");
});
