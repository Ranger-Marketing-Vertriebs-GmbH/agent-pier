import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
test("session launch passes an explicit native model without interpreting it as shell input", async (t) => {
  const f = await applicationFixture(t);
  let requested;
  f.application.accounts.command = (_id, _binaries, _login, _mode, options) => {
    requested = options.modelId;
    return {
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: { HOME: f.home, PATH: "/usr/bin:/bin" },
    };
  };
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-claude", cwd: f.home, nativeModelId: "sonnet[1m]" },
  });
  assert.equal(response.status, 201);
  assert.equal(requested, "sonnet[1m]");
});
test("invalid native model selections fail before starting any process", async (t) => {
  const f = await applicationFixture(t);
  let commands = 0;
  f.application.accounts.command = () => {
    commands++;
    throw Error("must not launch");
  };
  for (const selection of [
    { accountId: "local-shell", nativeModelId: "model" },
    { accountId: "local-claude", nativeModelId: 42 },
    { accountId: "local-codex", nativeModelId: "model --flag" },
    { accountId: "local-codex", nativeModelId: "x".repeat(201) },
  ]) {
    const response = await f.request("/api/sessions", {
      method: "POST",
      body: { cwd: f.home, ...selection },
    });
    assert.equal(response.status, 400);
  }
  assert.equal(commands, 0);
});
