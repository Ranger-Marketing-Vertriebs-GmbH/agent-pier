import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("Claude login status uses the selected profile and returns no native credential details", async (t) => {
  const f = await applicationFixture(t);
  const account = f.application.accounts.create({ name: "Work", tool: "claude" });
  const binary = path.join(f.root, "claude-status");
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nconst ok=process.env.CLAUDE_CONFIG_DIR===${JSON.stringify(path.join(f.dataDir, "profiles", account.id, "claude"))};console.log(JSON.stringify({loggedIn:ok,authMethod:'claude.ai',email:'private@example.invalid',accessToken:'synthetic-do-not-return'}));process.exitCode=ok?0:1;`,
    { mode: 0o700 },
  );
  f.application.accountAuthStatus.tools = () => [
    { id: "claude", installed: true, path: binary },
  ];
  const response = await f.request(`/api/accounts/${account.id}/auth-status`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, "authenticated");
  assert.ok(result.checkedAt);
  assert.ok(!JSON.stringify(result).includes("private@"));
  assert.ok(!JSON.stringify(result).includes("synthetic-do-not-return"));
});

test("missing CLI and malformed output never claim a successful login", async (t) => {
  const f = await applicationFixture(t);
  const account = f.application.accounts.create({ name: "Work", tool: "claude" });
  f.application.accountAuthStatus.tools = () => [];
  let response = await f.request(`/api/accounts/${account.id}/auth-status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "unknown");
  response = await f.request("/api/accounts/missing/auth-status");
  assert.equal(response.status, 404);
});

for (const [output, exitCode, expected] of [
  ["not-json", 0, "unknown"],
  ['{"loggedIn":false}', 1, "unauthenticated"],
  ['{"loggedIn":true}', 2, "unknown"],
])
  test(`Claude auth probe handles exit ${exitCode} and ${expected} output`, async (t) => {
    const f = await applicationFixture(t);
    const account = f.application.accounts.create({ name: "Status", tool: "claude" });
    const binary = path.join(f.root, "status-cli");
    await fs.writeFile(
      binary,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(output)});process.exitCode=${exitCode};`,
      { mode: 0o700 },
    );
    f.application.accountAuthStatus.tools = () => [
      { id: "claude", installed: true, path: binary },
    ];
    assert.equal(
      (await (await f.request(`/api/accounts/${account.id}/auth-status`)).json()).state,
      expected,
    );
  });

for (const [tool, args, output, exitCode, expected] of [
  ["codex", ["login", "status"], "Logged in using ChatGPT", 0, "authenticated"],
  [
    "codex",
    ["login", "status"],
    "Logged in using an API key - fixture-secret",
    0,
    "authenticated",
  ],
  ["codex", ["login", "status"], "Not logged in", 1, "unauthenticated"],
  ["codex", ["login", "status"], "unexpected output", 0, "unknown"],
  ["codex", ["login", "status"], "Logged in using ChatGPT", 2, "unknown"],
  ["opencode", ["auth", "list"], "┌ Credentials\n└ 0 credentials", 0, "unauthenticated"],
  [
    "opencode",
    ["auth", "list"],
    "┌ Credentials\n│ Provider oauth\n└ 1 credential",
    0,
    "authenticated",
  ],
  ["opencode", ["auth", "list"], "┌ Credentials\n└ 2 credentials", 0, "authenticated"],
  ["opencode", ["auth", "list"], "unexpected output", 0, "unknown"],
  ["opencode", ["auth", "list"], "└ 1 credential", 1, "unknown"],
])
  test(`${tool} local status handles exit ${exitCode}: ${output}`, async (t) => {
    const f = await applicationFixture(t);
    const binary = path.join(f.root, "status-cli");
    await fs.writeFile(
      binary,
      `#!${process.execPath}\nconst ok=JSON.stringify(process.argv.slice(2))===${JSON.stringify(JSON.stringify(args))} && process.env.HOME===${JSON.stringify(f.home)}; console.error(${JSON.stringify(output)}); process.exitCode=ok?${exitCode}:3;`,
      { mode: 0o700 },
    );
    f.application.accountAuthStatus.tools = () => [
      { id: tool, installed: true, path: binary },
    ];
    const response = await f.request(`/api/accounts/local-${tool}/auth-status`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.state, expected);
    assert.ok(result.checkedAt);
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  });
