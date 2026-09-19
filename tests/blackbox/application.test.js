import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";

/**
 * A stand-in for the real nono binary: `profile list --silent` reports one
 * sandbox profile in the exact column layout `parseSandboxProfiles` expects,
 * and `wrap … -- <command> <args>` execs straight into the wrapped CLI. Only
 * the fixture's `nonoSandbox.detect` is stubbed below, so this script is a
 * real, executable file: the session manager's own executable checks pass and
 * the session actually runs.
 */
async function fakeNonoExecutable(root) {
  const executable = path.join(root, "fake-bin", "nono");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(
    executable,
    `#!/bin/sh
cmd="$1"
shift
if [ "$cmd" = "profile" ] && [ "$1" = "list" ]; then
  cat <<'PROFILES'
nono profile: 1 profiles
User (fixture):
    shell-default  fixture profile
PROFILES
  exit 0
fi
if [ "$cmd" = "wrap" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then
      shift
      exec "$@"
    fi
    shift
  done
fi
exit 1
`,
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

async function json(response, expected) {
  assert.equal(response.status, expected);
  return response.json();
}

test("HTTP account and GitHub metadata persist across a full application restart without exposing secrets", async (t) => {
  const fixture = await applicationFixture(t);
  const account = await json(
    await fixture.request("/api/accounts", {
      method: "POST",
      body: {
        name: "Persisted account",
        tool: "claude",
        apiKey: "fixture-account-secret",
      },
    }),
    201,
  );
  const credential = await json(
    await fixture.request("/api/git-credentials", {
      method: "POST",
      body: {
        name: "Persisted host",
        host: "enterprise.example.test",
        token: "fixture-github-secret",
      },
    }),
    201,
  );
  assert.equal(account.hasSecret, true);
  assert.equal(credential.hasSecret, true);
  await fixture.restart();
  const state = await json(await fixture.request("/api/state"), 200);
  const repositories = await json(await fixture.request("/api/repositories"), 200);
  assert.equal(
    state.accounts.find((item) => item.id === account.id).name,
    "Persisted account",
  );
  assert.equal(
    repositories.credentials.find((item) => item.id === credential.id).host,
    "https://enterprise.example.test",
  );
  assert.equal(
    JSON.stringify({ account, credential, state, repositories }).includes(
      "fixture-account-secret",
    ),
    false,
  );
  assert.equal(JSON.stringify(repositories).includes("fixture-github-secret"), false);
  assert.equal(
    (await fixture.request(`/api/accounts/${account.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (
      await fixture.request(`/api/git-credentials/${credential.id}`, {
        method: "DELETE",
      })
    ).status,
    204,
  );
});

test("HTTP origin and malformed-input boundaries reject mutations without creating state or leaking inputs", async (t) => {
  const fixture = await applicationFixture(t);
  await assert.rejects(
    fixture.request("https://foreign.example/api/state"),
    /own application origin/,
  );
  const before = await json(await fixture.request("/api/state"), 200);
  const payload = {
    name: "Rejected",
    tool: "codex",
    apiKey: "fixture-error-secret",
  };
  for (const origin of ["https://foreign.example", "null", null]) {
    const response = await fixture.request("/api/accounts", {
      method: "POST",
      origin,
      body: payload,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(payload.apiKey), false);
  }
  const malformed = await fetch(`${fixture.url}/api/accounts`, {
    method: "POST",
    headers: { origin: fixture.url, "content-type": "application/json" },
    body: '{"apiKey":"fixture-error-secret",',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(payload.apiKey), false);
  const after = await json(await fixture.request("/api/state"), 200);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.sessions, []);
  for (const endpoint of [
    "/.data/accounts.json",
    "/.data/repository-secrets/unknown.json",
  ])
    assert.notEqual((await fixture.request(endpoint)).status, 200);
  const missing = await fixture.request("/api/accounts/absent-profile", {
    method: "PATCH",
    body: { name: "Missing", apiKey: payload.apiKey },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.text()).includes(payload.apiKey), false);
});

test("fixture shutdown removes only its temporary application data and private tmux directory", async (t) => {
  const fixture = await applicationFixture(t);
  const socketDirectory = path.dirname(fixture.application.sessions.socketPath);
  const sibling = `${fixture.root}-outside`;
  await fs.mkdir(sibling);
  t.after(() => fs.rm(sibling, { recursive: true, force: true }));
  await fixture.dispose();
  assert.equal(await fs.stat(fixture.root).catch(() => null), null);
  assert.equal(await fs.stat(socketDirectory).catch(() => null), null);
  assert.equal((await fs.stat(sibling)).isDirectory(), true);
});

test("a fixture-owned Shell session survives web-server restart and is removed through the HTTP lifecycle", async (t) => {
  const fixture = await applicationFixture(t);
  const session = await json(
    await fixture.request("/api/sessions", {
      method: "POST",
      body: {
        accountId: "local-shell",
        name: "Fixture shell",
        cwd: fixture.home,
      },
    }),
    201,
  );
  assert.equal(session.tool, "shell");
  assert.equal(session.status, "running");
  await fixture.restart();
  const state = await json(await fixture.request("/api/state"), 200);
  assert.equal(state.sessions.find((item) => item.id === session.id).status, "running");
  assert.equal(
    (await fixture.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
    409,
  );
  assert.equal(
    (
      await fixture.request(`/api/sessions/${session.id}/stop`, {
        method: "POST",
      })
    ).status,
    200,
  );
  assert.equal(
    (await fixture.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (
      await fixture.request("/api/state").then((response) => response.json())
    ).sessions.some((item) => item.id === session.id),
    false,
  );
});

test("an ordinary unsandboxed launch reaches the SSH launch adapter with its validated assignment", async (t) => {
  const fixture = await applicationFixture(t);
  // Regression: the validated SSH selection is built in the outer launch step
  // and consumed in the inner one, so a selection that never reaches the
  // preparation path fails every launch, sandbox or not, with HTTP 400.
  for (const sshAccessIds of [undefined, []]) {
    const session = await json(
      await fixture.request("/api/sessions", {
        method: "POST",
        body: {
          accountId: "local-shell",
          name: `Ordinary ${sshAccessIds ? "empty" : "absent"} assignment`,
          cwd: fixture.home,
          ...(sshAccessIds ? { sshAccessIds } : {}),
        },
      }),
      201,
    );
    assert.equal(session.status, "running");
    assert.equal("sandbox" in session, false);
    await fixture.request(`/api/sessions/${session.id}/stop`, { method: "POST" });
    await fixture.request(`/api/sessions/${session.id}`, { method: "DELETE" });
  }
});

test("a session naming a sandbox profile is rejected when nono is not detected", async (t) => {
  const fixture = await applicationFixture(t);
  // The lifecycle closed over this object when the fixture started, so the
  // detection it consults must be mutated in place rather than replaced.
  fixture.application.nonoSandbox.detect = () => [];
  const response = await fixture.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-shell",
      name: "Unavailable sandbox",
      cwd: fixture.home,
      nonoProfile: "shell-default",
    },
  });
  assert.equal(response.status, 400);
  const state = await json(await fixture.request("/api/state"), 200);
  assert.equal(state.sessions.length, 0);
});

test("a sandboxed session's public record carries its sandbox profile and survives a restart, while an unsandboxed session carries no sandbox key", async (t) => {
  const fixture = await applicationFixture(t);
  const executable = await fakeNonoExecutable(fixture.root);
  // Mutated in place for the same reason as above: the lifecycle already
  // holds a reference to this object.
  fixture.application.nonoSandbox.detect = () => [
    { id: "nono", name: "nono", utility: true, installed: true, path: executable },
  ];
  const sandboxed = await json(
    await fixture.request("/api/sessions", {
      method: "POST",
      body: {
        accountId: "local-shell",
        name: "Sandboxed shell",
        cwd: fixture.home,
        nonoProfile: "shell-default",
      },
    }),
    201,
  );
  assert.deepEqual(sandboxed.sandbox, { profile: "shell-default" });
  // A broken exec through the wrap would still persist a sandbox record, so the
  // record alone does not prove the CLI actually started; the fake nono's exec
  // into the CLI must have succeeded too.
  assert.equal(sandboxed.status, "running");
  const unsandboxed = await json(
    await fixture.request("/api/sessions", {
      method: "POST",
      body: { accountId: "local-shell", name: "Unsandboxed shell", cwd: fixture.home },
    }),
    201,
  );
  assert.equal("sandbox" in unsandboxed, false);
  await fixture.restart();
  const state = await json(await fixture.request("/api/state"), 200);
  const sandboxedAfterRestart = state.sessions.find((item) => item.id === sandboxed.id);
  assert.deepEqual(sandboxedAfterRestart.sandbox, { profile: "shell-default" });
  assert.equal(sandboxedAfterRestart.status, "running");
  assert.equal(
    "sandbox" in state.sessions.find((item) => item.id === unsandboxed.id),
    false,
  );
  for (const session of [sandboxed, unsandboxed]) {
    await fixture.request(`/api/sessions/${session.id}/stop`, { method: "POST" });
    await fixture.request(`/api/sessions/${session.id}`, { method: "DELETE" });
  }
});
