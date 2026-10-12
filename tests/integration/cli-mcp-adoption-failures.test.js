import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { adoptFinds } from "../../server/features/mcp-servers/cli-adoption.js";
import { groupFinds } from "../../server/features/mcp-servers/cli-finds.js";
import { clis } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture } from "../helpers/cli-mcp.js";
import { adoptFailure } from "../../server/features/mcp-servers/cli-status.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

// Adopt all names every failure with a stable reason; the cause is never lost.
const groups = (f) =>
  groupFinds(Object.fromEntries(clis.map((cli) => [cli, f.reconciler.inspect(cli)])), []);
const group = {
  key: "k1",
  name: "tool",
  parsed: {
    ok: true,
    definition: { transport: "stdio", command: "/fake/bin/tool", args: [] },
    secrets: { env: { TOKEN: "env-secret" }, headers: {} },
  },
  members: [{ cli: "claude", name: "tool", hash: "h" }],
};

test("adopt all reports an unwritable CLI file as write-failed, not as unadoptable", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", {
    "my.tool": { type: "stdio", command: "/fake/bin/tool", env: { T: "env-secret" } },
  });
  const found = groups(f);
  fs.chmodSync(f.home, 0o500);
  let result;
  try {
    result = adoptFinds({
      servers: f.servers,
      reconciler: f.reconciler,
      groups: found,
      all: true,
      warn: () => {},
    });
  } finally {
    fs.chmodSync(f.home, 0o700);
  }
  assert.deepEqual(
    result.failed.map((item) => [item.name, item.reason, item.messageKey]),
    [["my.tool", "write-failed", "mcpServers.cliReasonWriteFailed"]],
  );
  assert.deepEqual(f.servers.list(), []);
});

test("a failing cleanup is logged by code and never hides the cause", () => {
  const warnings = [];
  const cause = Object.assign(new Error("lost"), {
    status: 409,
    code: "CLI_CONFIG_CHANGED",
  });
  const servers = {
    create: () => ({ id: "s1", name: "tool" }),
    remove: () => {
      throw Object.assign(new Error("/private/path env-secret"), { code: "EBUSY" });
    },
  };
  const reconciler = {
    check: () => {},
    adopt: () => {
      throw cause;
    },
  };
  assert.throws(
    () =>
      adoptFinds({
        servers,
        reconciler,
        groups: [group],
        keys: ["k1"],
        warn: (line) => warnings.push(line),
      }),
    (error) => error === cause,
  );
  assert.deepEqual(warnings, ["An adopted MCP entry could not be undone (EBUSY)."]);
});

test("a bug while adopting is reported as failed and logged by code only", () => {
  const warnings = [];
  const { failed } = adoptFinds({
    servers: {
      create: () => {
        throw new TypeError("boom /private/path env-secret");
      },
    },
    reconciler: { check: () => {} },
    groups: [group],
    all: true,
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(
    failed.map((item) => [item.reason, item.messageKey]),
    [["failed", "mcpServers.cliReasonFailed"]],
  );
  assert.deepEqual(warnings, [
    "An MCP entry found in the CLIs could not be adopted (ERROR).",
  ]);
});

test("an environment-reference refusal is recognised by its code, not its wording", () => {
  const refusal = Object.assign(new Error("any wording"), {
    status: 409,
    code: "MCP_CLI_FIND_ENV_REFERENCES",
  });
  assert.deepEqual(
    adoptFailure(refusal, () => {}),
    {
      reason: "env-references",
      error: serverMessages.mcpServers.cliFindEnvReferences,
      messageKey: "mcpServers.cliFindEnvReferences",
    },
  );
});
