import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cliEnvironment,
  createMcpCli,
  McpCliError,
  oauthStatus,
  parseLoginOutput,
  redact,
  supervisorMcpCli,
} from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";

const fakeEntry = fileURLToPath(
  new URL("../fixtures/fake-openclaw-mcp.mjs", import.meta.url),
);
const runtime = { nodePath: process.execPath, entryPath: fakeEntry };

function setup(t, mode = "ok", options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, "record.json");
  const cli = createMcpCli({
    runtime: { ...runtime, cwd: dir },
    environment: () => ({
      PATH: process.env.PATH,
      HOME: dir,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: path.join(dir, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
      FAKE_OPENCLAW_MODE: mode,
      FAKE_OPENCLAW_RECORD: record,
    }),
    ...options,
  });
  return { cli, recorded: () => JSON.parse(fs.readFileSync(record, "utf8")) };
}

const rejects = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof McpCliError);
    assert.equal(error.code, code);
    return true;
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("startLogin parses the authorization URL and state from the recorded output", async (t) => {
  for (const mode of ["ok", "https"]) {
    const { cli, recorded } = setup(t, mode);
    const login = await cli.startLogin("docs");
    assert.equal(login.state, "3f2b8c1e-4d5a-4f6b-9c7d-8e9f0a1b2c3d");
    const url = new URL(login.authorizationUrl);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), login.state);
    const run = recorded();
    assert.deepEqual(run.argv, ["mcp", "login", "docs"]);
    assert.equal(run.env.OPENCLAW_GATEWAY_TOKEN, undefined, "no Gateway token");
    assert.ok(run.env.OPENCLAW_STATE_DIR && run.env.OPENCLAW_CONFIG_PATH);
  }
});

test("a login that only refreshes reports authorized without a URL", async (t) => {
  const { cli } = setup(t, "refresh");
  assert.deepEqual(await cli.startLogin("docs"), { authorized: true });
});

test("a login without an authorization URL or state fails with url-missing", async (t) => {
  for (const mode of ["no-url", "no-state"]) {
    const { cli } = setup(t, mode);
    await rejects(cli.startLogin("docs"), "url-missing");
  }
  assert.equal(
    parseLoginOutput('Open this URL to authorize "docs":\nfile:///x?state=a', "docs"),
    null,
  );
});

test("a hanging CLI times out and only its own child is killed", async (t) => {
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => bystander.kill("SIGKILL"));
  const { cli, recorded } = setup(t, "hang", { timeoutMs: 1500 });
  const started = Date.now();
  await rejects(cli.startLogin("docs"), "cli-timeout");
  assert.ok(Date.now() - started < 10000);
  const { pid } = recorded();
  assert.equal(alive(pid), false, "the CLI child was killed");
  assert.equal(alive(bystander.pid), true, "an unrelated process survives");
});

test("output beyond the cap fails without hanging", async (t) => {
  const { cli } = setup(t, "flood", { maxOutputBytes: 4096 });
  await rejects(cli.status(), "cli-failed");
});

test("known OpenClaw failures map to stable codes", async (t) => {
  const cases = {
    "fail-dcr": "no-dynamic-registration",
    "fail-redirect": "redirect-rejected",
    "fail-session": "session-missing",
    "fail-unknown": "server-unknown",
    "fail-generic": "cli-failed",
  };
  for (const [mode, code] of Object.entries(cases)) {
    const { cli } = setup(t, mode);
    await rejects(cli.startLogin("docs"), code);
  }
  const { cli } = setup(t, "fail-session");
  await assert.rejects(
    cli.completeLogin("docs", "abc"),
    /Missing MCP OAuth authorization/,
  );
});

test("completeLogin passes the code as one argument and never reveals it", async (t) => {
  const code = "-SplxlOBeZQQYbYS6WxSbIA";
  const ok = setup(t);
  await ok.cli.completeLogin("docs", code);
  assert.deepEqual(ok.recorded().argv, ["mcp", "login", "docs", `--code=${code}`]);

  const failing = setup(t, "fail-generic");
  await assert.rejects(failing.cli.completeLogin("docs", code), (error) => {
    assert.equal(error.code, "cli-failed");
    assert.ok(!error.message.includes(code), error.message);
    assert.ok(!error.message.includes("abc.def.ghi"), error.message);
    assert.ok(!error.stack.includes(code));
    return true;
  });
  for (const bad of ["", "a b", "a\nb", null, "x".repeat(5000)])
    await rejects(ok.cli.completeLogin("docs", bad), "invalid-code");
});

test("invalid server names never reach the CLI", async (t) => {
  const { cli } = setup(t);
  for (const bad of ["a b", "-x", "a;rm", "", null, "a".repeat(31), "$(x)"]) {
    await rejects(cli.startLogin(bad), "invalid-name");
    await rejects(cli.logout(bad), "invalid-name");
  }
});

test("logout clears credentials", async (t) => {
  const { cli, recorded } = setup(t);
  await cli.logout("docs");
  assert.deepEqual(recorded().argv, ["mcp", "logout", "docs"]);
});

test("status maps every recorded state of OAuth servers", async (t) => {
  const { cli, recorded } = setup(t);
  const status = await cli.status();
  assert.deepEqual(recorded().argv, ["mcp", "status", "--json"]);
  assert.deepEqual(Object.keys(status).sort(), [
    "docs",
    "fresh",
    "pending",
    "refused",
    "revoked",
  ]);
  assert.deepEqual(status.docs, {
    state: "authorized",
    hasTokens: true,
    requiresAuthorization: false,
    hasClientInformation: true,
    expiresAt: 1791234567890,
  });
  assert.equal(status.fresh.state, "unauthenticated");
  assert.equal(status.pending.state, "pending-authorization");
  assert.equal(status.revoked.hasTokens, false);
  assert.equal(status.refused.state, "requires-authorization");

  assert.equal(oauthStatus(status.docs), "connected");
  assert.equal(oauthStatus(status.docs, { pendingLogin: true }), "connected");
  assert.equal(oauthStatus(status.refused), "login-required");
  assert.equal(oauthStatus(status.refused, { pendingLogin: true }), "login-pending");
  assert.equal(oauthStatus(status.revoked), "login-required");
  assert.equal(oauthStatus(status.pending, { pendingLogin: true }), "login-pending");
  assert.equal(oauthStatus(status.pending), "login-required");
  assert.equal(oauthStatus(status.fresh), "not-connected");
  assert.equal(oauthStatus(status.fresh, { everConnected: true }), "login-required");
  assert.equal(oauthStatus(undefined), "not-connected");
});

test("redaction removes codes, URL credentials and token-like strings", () => {
  const text =
    "failed for code=abc123 at https://as.example/token?code=abc123&state=s1 " +
    "Bearer eyJhbGciOi.eyJzdWIiOi.sig and secret-value%2F1 " +
    "token zA9xY8wV7uT6sR5qP4oN3mL2kJ1";
  const out = redact(text, ["secret-value/1"]);
  for (const leaked of [
    "abc123",
    "s1 ",
    "eyJ",
    "secret-value",
    "zA9xY8wV7uT6sR5qP4oN3mL2kJ1",
  ])
    assert.ok(!out.includes(leaked), `${leaked} in ${out}`);
  assert.match(out, /^failed for code=\[redacted\] at https:\/\/as\.example\/token/);
});

test("a supervisor without a launched runtime fails with runtime-unavailable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-sup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const supervisor = { paths: runtimePaths(dir), runtime: null };
  const cli = supervisorMcpCli(supervisor);
  await rejects(cli.status(), "runtime-unavailable");
  await rejects(cli.startLogin("docs"), "runtime-unavailable");

  supervisor.runtime = runtime;
  const status = await cli.status();
  assert.equal(status.docs.state, "authorized");
});

test("the CLI environment is the Gateway's private one without its token", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  const env = cliEnvironment(paths, "/opt/rt/node/bin/node", { HOME: "/home/user" });
  assert.equal(env.HOME, paths.home);
  assert.equal(env.OPENCLAW_STATE_DIR, paths.state);
  assert.equal(env.OPENCLAW_CONFIG_PATH, paths.config);
  assert.ok(env.PATH.startsWith("/opt/rt/node/bin"));
  assert.equal("OPENCLAW_GATEWAY_TOKEN" in env, false);
});
