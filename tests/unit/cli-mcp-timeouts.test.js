import test from "node:test";
import assert from "node:assert/strict";
import { cases } from "../fixtures/cli-mcp-shapes.js";
import {
  centralFromNative,
  cliEntry,
  clis,
} from "../../server/features/mcp-servers/cli-native.js";
import {
  cleanTimeout,
  readTimeout,
  timeoutBounds,
} from "../../server/features/mcp-servers/mcp-timeouts.js";

const stdio = cases.find((item) => item.id === "stdio-timeouts");
const none = { headers: {}, env: {} };
const nullTimeouts = { startupTimeoutSec: null, toolTimeoutSec: null };

test("the timeout bounds are 1 to 600 s for startup and 1 to 3600 s for tools", () => {
  assert.deepEqual(timeoutBounds, {
    startupTimeoutSec: { min: 1, max: 600 },
    toolTimeoutSec: { min: 1, max: 3600 },
  });
});

test("a Codex entry with both timeouts adopts with its values", () => {
  for (const entry of [
    { url: "https://x.test/mcp", startup_timeout_sec: 30, tool_timeout_sec: 450 },
    // TOML floats with a whole value are whole seconds.
    {
      command: "/bin/rea",
      args: [],
      env: {},
      startup_timeout_sec: 30.0,
      tool_timeout_sec: 450.0,
    },
  ]) {
    const parsed = centralFromNative("codex", entry);
    assert.equal(parsed.ok, true, JSON.stringify(entry));
    assert.equal(parsed.definition.startupTimeoutSec, 30);
    assert.equal(parsed.definition.toolTimeoutSec, 450);
    assert.deepEqual(cliEntry("codex", parsed.definition, parsed.secrets), entry);
  }
});

test("only Codex gets the startup timeout; the others carry the tool timeout", () => {
  const startupOnly = { ...stdio.central, toolTimeoutSec: null };
  assert.equal(cliEntry("codex", startupOnly, none).startup_timeout_sec, 30);
  assert.equal(cliEntry("codex", startupOnly, none).tool_timeout_sec, undefined);
  for (const cli of ["claude", "opencode"])
    assert.equal(Object.hasOwn(cliEntry(cli, startupOnly, none), "timeout"), false);
  for (const cli of clis) {
    const plain = cliEntry(cli, { ...stdio.central, ...nullTimeouts }, none);
    assert.doesNotMatch(JSON.stringify(plain), /timeout/, cli);
  }
});

test("a hand edit in Claude Code or OpenCode reads the tool timeout back", () => {
  for (const cli of ["claude", "opencode"]) {
    const parsed = centralFromNative(cli, stdio.native[cli]);
    assert.equal(parsed.ok, true, cli);
    assert.equal(parsed.definition.toolTimeoutSec, 450, cli);
    assert.equal(parsed.definition.startupTimeoutSec, null, cli);
  }
});

test("timeouts outside the bounds or not in whole seconds stay unmanaged", () => {
  const unmanaged = (cli, entry, key) =>
    assert.deepEqual(
      centralFromNative(cli, entry),
      { ok: false, reason: "unsupported-fields", keys: [key] },
      `${cli} ${JSON.stringify(entry)}`,
    );
  const url = "https://x.test/mcp";
  for (const value of [0, 601, 2.5, -1, "30", true])
    unmanaged("codex", { url, startup_timeout_sec: value }, "startup_timeout_sec");
  for (const value of [0, 3601, 0.5])
    unmanaged("codex", { url, tool_timeout_sec: value }, "tool_timeout_sec");
  // Codex reads the millisecond alias too; AgentPier does not manage it.
  unmanaged("codex", { url, startup_timeout_ms: 30000 }, "startup_timeout_ms");
  // Claude Code ignores values below 1000 ms; a fraction of a second has no field.
  for (const value of [500, 1500, 3601000, "60000", null])
    unmanaged("claude", { type: "http", url, timeout: value }, "timeout");
  for (const value of [999, 2500, 3601000])
    unmanaged("opencode", { type: "remote", url, timeout: value }, "timeout");
});

test("the store input accepts whole seconds within bounds and clears with null", () => {
  assert.equal(cleanTimeout("startupTimeoutSec", undefined), undefined);
  assert.equal(cleanTimeout("startupTimeoutSec", null), null);
  assert.equal(cleanTimeout("startupTimeoutSec", ""), null);
  assert.equal(cleanTimeout("startupTimeoutSec", 600), 600);
  assert.equal(cleanTimeout("toolTimeoutSec", 1), 1);
  assert.equal(cleanTimeout("toolTimeoutSec", 3600), 3600);
  for (const [field, value] of [
    ["startupTimeoutSec", 0],
    ["startupTimeoutSec", 601],
    ["startupTimeoutSec", 2.5],
    ["startupTimeoutSec", "30"],
    ["toolTimeoutSec", 3601],
    ["toolTimeoutSec", Number.NaN],
    ["toolTimeoutSec", {}],
  ])
    assert.throws(() => cleanTimeout(field, value), {
      status: 400,
      code: "MCP_SERVER_TIMEOUT_INVALID",
      field,
    });
});

test("a stored timeout outside the bounds reads as none", () => {
  assert.equal(readTimeout("toolTimeoutSec", 450), 450);
  assert.equal(readTimeout("toolTimeoutSec", null), null);
  assert.equal(readTimeout("toolTimeoutSec", 99999), null);
  assert.equal(readTimeout("startupTimeoutSec", 1.5), null);
});
