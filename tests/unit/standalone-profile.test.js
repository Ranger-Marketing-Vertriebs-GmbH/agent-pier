import test from "node:test";
import assert from "node:assert/strict";
import { NativePipelineDriver } from "../../server/features/pipelines/native-driver.js";

function fixture(tool = "codex") {
  const profile = {
    id: "profile-test",
    name: "Planner",
    enabled: true,
    config: {
      cliTool: tool,
      accountId: `local-${tool}`,
      models: { available: ["pinned"], default: "pinned" },
      permissions: {
        mode: tool === "codex" ? "on-request" : tool === "claude" ? "plan" : "ask",
      },
      run: { autonomous: false },
      prompts: {
        role: "Review carefully",
        kickoff: "Inspect {{topic}}",
        params: [{ key: "topic", label: "Topic", required: true }],
      },
    },
  };
  const accounts = {
    get: (id) => ({
      id,
      tool: id === "wrong-cli" ? "shell" : id.startsWith("local-") ? id.slice(6) : tool,
    }),
  };
  let captured;
  const driver = {
    accounts,
    lifecycle: {
      async launch(body, login, trusted) {
        trusted.validateAccount(accounts.get(body.accountId));
        const launch = {
          command: "fixture",
          args:
            body.launchMode === "yolo"
              ? ["--dangerously-bypass-approvals-and-sandbox"]
              : [],
          env: {},
        };
        captured = {
          body,
          login,
          model: trusted.modelId,
          command: trusted.transformLaunch({ launch, id: trusted.id }),
        };
        return { id: trusted.id };
      },
    },
  };
  return {
    profile,
    launch: (body) =>
      NativePipelineDriver.prototype.launchProfile.call(driver, profile, body),
    captured: () => captured,
  };
}

test("standalone profile keeps prompts while applying session choices without changing the profile", async () => {
  const f = fixture(),
    original = structuredClone(f.profile);
  await f.launch({
    cwd: "/fixture/project",
    name: "My review",
    params: { topic: "changes" },
    access: { tool: "codex", accountId: "other-codex", nativeModelId: "other-model" },
    launchMode: "yolo",
    agentbus: false,
    agentpierTools: true,
    sshAccessIds: ["fixture-host"],
  });
  const result = f.captured();
  assert.equal(result.body.accountId, "other-codex");
  assert.equal(result.body.name, "My review");
  assert.equal(result.body.cwd, "/fixture/project");
  assert.equal(result.body.agentbus, false);
  assert.equal(result.body.agentpierTools, true);
  assert.deepEqual(result.body.sshAccessIds, ["fixture-host"]);
  assert.equal(result.model, "other-model");
  assert.deepEqual(result.command.args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "--",
    "Review carefully\n\nInspect changes",
  ]);
  assert.deepEqual(f.profile, original);
});

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} standalone launch preserves profile permissions unless explicitly overridden`, async () => {
    const f = fixture(tool);
    await f.launch({ params: { topic: "code" } });
    const args = f.captured().command.args;
    if (tool === "codex") assert.ok(args.includes('approval_policy="on-request"'));
    if (tool === "claude") assert.ok(args.includes("plan"));
    if (tool === "opencode") assert.equal(args.includes("--auto"), false);
    assert.equal(f.captured().model, "pinned");
    await f.launch({ params: { topic: "code" }, launchMode: "default" });
    const overridden = f.captured().command.args;
    assert.equal(overridden.includes('approval_policy="on-request"'), false);
    assert.equal(overridden.includes("plan"), false);
    if (tool === "claude")
      assert.equal(overridden.filter((arg) => arg === "--session-id").length, 1);
    assert.ok(overridden.includes("Review carefully\n\nInspect code"));
  });

test("standalone choices reject mismatched access and still require profile parameters", async () => {
  const f = fixture();
  for (const access of [
    null,
    { tool: "claude", accountId: "local-codex" },
    { tool: "codex", accountId: "wrong-cli" },
    {
      tool: "codex",
      accountId: "local-codex",
      providerConnectionId: "connection",
      nativeModelId: "model",
    },
  ])
    await assert.rejects(f.launch({ access, params: { topic: "code" } }));
  await assert.rejects(f.launch({ params: {} }), /required/);
  await assert.rejects(
    f.launch({ params: { topic: "code" }, model: "not-allowed" }),
    /not available/,
  );
  f.profile.enabled = false;
  await assert.rejects(f.launch({ params: { topic: "code" } }), /disabled/);
  assert.equal(f.captured(), undefined);
});

for (const tool of ["codex", "claude", "opencode"])
  test(`changing a standalone profile CLI to ${tool} retains its rendered instructions`, async () => {
    const f = fixture(tool === "claude" ? "codex" : "claude");
    const original = structuredClone(f.profile);
    await f.launch({
      access: { tool, accountId: `local-${tool}`, nativeModelId: "selected-model" },
      params: { topic: "the reported bug" },
      launchMode: "default",
    });
    const result = f.captured();
    assert.equal(result.body.accountId, `local-${tool}`);
    assert.equal(result.model, "selected-model");
    assert.deepEqual(result.command.args.slice(-2), [
      tool === "opencode" ? "--prompt" : "--",
      "Review carefully\n\nInspect the reported bug",
    ]);
    assert.deepEqual(f.profile, original);
  });

test("switching from Claude to Codex without a mode override uses Codex permissions", async () => {
  const f = fixture("claude");
  await f.launch({
    access: { tool: "codex", accountId: "local-codex" },
    params: { topic: "bug" },
  });
  assert.ok(f.captured().command.args.includes('approval_policy="on-request"'));
});
