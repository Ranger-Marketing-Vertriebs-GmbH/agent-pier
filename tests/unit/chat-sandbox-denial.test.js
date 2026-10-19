import test from "node:test";
import assert from "node:assert/strict";
import { sandboxDenied } from "../../web/features/chat/sandbox-denial.js";

const failed = (text, extra = {}) => ({
  role: "tool",
  toolName: "mcp__rea__process_attach",
  status: "failed",
  text,
  ...extra,
});

test("a failed tool call with a denial in a sandboxed session is blocked by the sandbox", () => {
  for (const text of [
    "Error: EPERM: operation not permitted, open '/Users/me/target'",
    "attach failed: Operation not permitted",
    "Sandbox: lldb(4711) deny(1) process-info-pidinfo",
    "error: process exited: sandbox denied mach-lookup",
    "ps: /bin/ps: Operation not permitted",
    "Error: EACCES: permission denied, open '/proc/4711/mem'",
    '{"error":"spawn /usr/bin/lldb EACCES"}',
  ])
    assert.equal(sandboxDenied(failed(text), "claude-default"), true, text);
});

test("no sandbox, no failure or no denial means no notice", () => {
  const denial = "Error: EPERM: operation not permitted";
  assert.equal(sandboxDenied(failed(denial), ""), false);
  assert.equal(sandboxDenied(failed(denial), undefined), false);
  assert.equal(sandboxDenied(failed(denial, { status: "completed" }), "p"), false);
  assert.equal(sandboxDenied(failed(denial, { status: "running" }), "p"), false);
  assert.equal(sandboxDenied(failed("Error: connection refused"), "p"), false);
  assert.equal(
    sandboxDenied(failed("Permission to use Bash has been denied."), "p"),
    false,
    "the CLI's own permission refusal is not a sandbox denial",
  );
  assert.equal(sandboxDenied(failed(""), "p"), false);
  assert.equal(sandboxDenied(failed(undefined), "p"), false);
  assert.equal(
    sandboxDenied(failed(denial, { subagent: { description: "x" } }), "p"),
    false,
    "subagent rows summarise many calls",
  );
  assert.equal(
    sandboxDenied({ role: "assistant", status: "failed", text: denial }, "p"),
    false,
  );
});

test("only the start and end of a long output are scanned", () => {
  const tail = "y".repeat(300000) + "\nEPERM: operation not permitted";
  assert.equal(sandboxDenied(failed(tail), "p"), true);
  const head = "EPERM: operation not permitted\n" + "y".repeat(300000);
  assert.equal(sandboxDenied(failed(head), "p"), true);
  const middle = "y".repeat(150000) + " EPERM " + "y".repeat(150000);
  assert.equal(sandboxDenied(failed(middle), "p"), false);
});
