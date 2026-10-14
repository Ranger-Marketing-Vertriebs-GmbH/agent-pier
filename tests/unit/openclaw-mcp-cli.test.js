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
  sweepLogoutConfigs,
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
  return { cli, record, recorded: () => JSON.parse(fs.readFileSync(record, "utf8")) };
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

test("an authorization URL OpenClaw's redaction masked is never handed out", async (t) => {
  // Printed by OpenClaw 2026.9.8 in CI (shortened): the masked challenge would make
  // the provider refuse the verifier at `--code`.
  const query = (challenge) =>
    `http://127.0.0.1:37559/authorize?response_type=code&client_id=client-1` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=3f2b8c1e-4d5a-4f6b-9c7d-8e9f0a1b2c3d`;
  const parse = (line) =>
    parseLoginOutput(`Open this URL to authorize "docs":\n${line}\n`, "docs");
  for (const challenge of [
    "8U-JRzEOa…BKJI",
    "phaju_90RaFjWrz6JlSAQLTVrNS***",
    "Zx9w8v7u6t5s4r3q2p1o0nMLKJIHGFEDCBA_abcdef",
  ])
    assert.deepEqual(parse(query(challenge)), { redacted: true }, challenge);
  const intact = "jQ_qw-2Rlr4cgFrhojDbbtYIjMQPyKOd7AA2PU7Uslw";
  assert.equal(parse(query(intact)).authorizationUrl, new URL(query(intact)).href);

  // A new login replaces the session with a fresh challenge.
  const once = setup(t, "redacted-once");
  const login = await once.cli.startLogin("docs");
  assert.ok(fs.existsSync(`${once.record}.redacted`), "the first login was redacted");
  assert.equal(
    new URL(login.authorizationUrl).searchParams.get("code_challenge"),
    "Zx9w8v7u6t5s4r3q2p1o0nMLKJIHGFEDCBA_abcdefg",
  );

  // A redaction that sticks fails after three logins instead of a broken URL.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-redacted-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const mode of ["redacted", "redacted-stars"]) {
    const log = path.join(dir, mode);
    const cli = createMcpCli({
      runtime,
      environment: () => ({
        PATH: process.env.PATH,
        FAKE_OPENCLAW_MODE: mode,
        FAKE_OPENCLAW_LOG: log,
      }),
    });
    await assert.rejects(cli.startLogin("docs"), (error) => {
      assert.equal(error.code, "url-missing");
      assert.match(error.message, /redacted authorization URL/);
      return true;
    });
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 3, mode);
  }
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

test("a timeout kills the CLI's whole process group", async (t) => {
  const { cli, record, recorded } = setup(t, "hang-group", { timeoutMs: 1500 });
  await rejects(cli.startLogin("docs"), "cli-timeout");
  const grandchild = Number(fs.readFileSync(`${record}.child`, "utf8"));
  t.after(() => alive(grandchild) && process.kill(grandchild, "SIGKILL"));
  // The kill is asynchronous; give the kernel a moment to reap the group.
  for (let i = 0; i < 50 && alive(grandchild); i++)
    await new Promise((done) => setTimeout(done, 20));
  assert.equal(alive(recorded().pid), false, "the CLI child was killed");
  assert.equal(alive(grandchild), false, "its own child was killed with it");
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
    // A printed URL carrying redirect_uri is not a rejected redirect.
    "fail-url": "cli-failed",
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

test("a call whose lease could not start on a locked database is repeated", async (t) => {
  // The lease transaction does not wait for a writer; failing to start it leaves
  // nothing done.
  const once = setup(t, "locked-once", { busyRetryDelaysMs: [10] });
  await once.cli.completeLogin("docs", "abc");
  assert.deepEqual(once.recorded().argv, ["mcp", "login", "docs", "--code=abc"]);
  assert.ok(fs.existsSync(`${once.record}.locked`), "the first call met the lock");

  // A lock that does not clear fails after the retries, with OpenClaw's reason; other
  // failures are not repeated.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-calls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = (mode) => {
    const log = path.join(dir, mode);
    const cli = createMcpCli({
      runtime,
      environment: () => ({
        PATH: process.env.PATH,
        FAKE_OPENCLAW_MODE: mode,
        FAKE_OPENCLAW_LOG: log,
      }),
      busyRetryDelaysMs: [10, 10],
    });
    return { cli, count: () => fs.readFileSync(log, "utf8").trim().split("\n").length };
  };
  const locked = calls("locked");
  await assert.rejects(locked.cli.logout("docs"), (error) => {
    assert.equal(error.code, "cli-failed");
    assert.match(error.message, /failed \(exit 1\): database is locked$/);
    return true;
  });
  assert.equal(locked.count(), 3);
  const leaseBusy = calls("lease-busy");
  await rejects(leaseBusy.cli.completeLogin("docs", "abc"), "cli-failed");
  assert.equal(leaseBusy.count(), 3);

  // A lock anywhere else may come after the code exchange: repeating `--code` with a
  // used code would make OpenClaw drop the tokens it just saved. Not repeated, nor are
  // other failures.
  for (const mode of ["locked-store", "locked-cleanup", "fail-generic"]) {
    const once = calls(mode);
    await rejects(once.cli.completeLogin("docs", "abc"), "cli-failed");
    assert.equal(once.count(), 1, mode);
  }
});

test("completeLogin passes the code as one argument and never reveals it", async (t) => {
  const code = "-SplxlOBeZQQYbYS6WxSbIA";
  const ok = setup(t);
  await ok.cli.completeLogin("docs", code);
  assert.deepEqual(ok.recorded().argv, ["mcp", "login", "docs", `--code=${code}`]);
  // OpenClaw 2026.10 prints a failure's "Reason:" line only with OPENCLAW_DEBUG.
  assert.equal(ok.recorded().env.OPENCLAW_DEBUG, "1");

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

test("logout with a server definition reads a private one-server config", async (t) => {
  const { cli, recorded } = setup(t);
  const server = { url: "https://mcp.example.com/v1", transport: "streamable-http" };
  await cli.logout("docs", { server: { ...server, auth: "oauth" } });
  const run = recorded();
  assert.deepEqual(run.argv, ["mcp", "logout", "docs"]);
  // Inside the Gateway's private state directory, not the shared temp directory.
  assert.equal(
    path.dirname(path.dirname(run.env.OPENCLAW_CONFIG_PATH)),
    run.env.OPENCLAW_STATE_DIR,
  );
  assert.match(
    path.basename(path.dirname(run.env.OPENCLAW_CONFIG_PATH)),
    /^agentpier-mcp-logout-/,
  );
  assert.equal(run.configMode & 0o777, 0o600);
  assert.equal(run.configDirMode & 0o777, 0o700);
  assert.deepEqual(run.config, {
    mcp: { servers: { docs: { ...server, auth: "oauth" } } },
  });
  assert.equal(fs.existsSync(run.env.OPENCLAW_CONFIG_PATH), false, "removed afterwards");
});

test("logout configs a killed run left behind are swept", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-sweep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "agentpier-mcp-logout-abc123"));
  fs.writeFileSync(path.join(dir, "agentpier-mcp-logout-abc123", "openclaw.json"), "{}");
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{}");
  assert.equal(sweepLogoutConfigs(dir), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["openclaw.json", "state"]);
  assert.equal(sweepLogoutConfigs(path.join(dir, "missing")), 0);
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
  // What a turn's failed start leaves on a server never logged in (live contract).
  const tried = { state: "pending-authorization", hasTokens: false };
  assert.equal(oauthStatus({ ...tried, hasClientInformation: false }), "not-connected");
  assert.equal(oauthStatus(tried, { everConnected: true }), "login-required");
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
  const parent = { HOME: "/home/user", HTTPS_PROXY: "http://proxy.test:3128" };
  const env = cliEnvironment(paths, "/opt/rt/node/bin/node", parent);
  assert.equal(env.HOME, paths.home);
  // The proxy comes from the given parent, not from AgentPier's own environment.
  assert.equal(env.HTTPS_PROXY, parent.HTTPS_PROXY);
  assert.equal(env.OPENCLAW_STATE_DIR, paths.state);
  assert.equal(env.OPENCLAW_CONFIG_PATH, paths.config);
  assert.ok(env.PATH.startsWith("/opt/rt/node/bin"));
  assert.equal("OPENCLAW_GATEWAY_TOKEN" in env, false);
});
