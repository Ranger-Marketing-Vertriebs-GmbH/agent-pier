import test from "node:test";
import assert from "node:assert/strict";
import { permissionClass } from "../../server/features/agentbus/agentbus-permission-class.js";

test("the permission class follows the unattended modes and arguments of the CLI", () => {
  const cases = [
    [{ tool: "claude", launchMode: "bypass" }, "bypass"],
    [
      { tool: "claude", permissionArgs: ["--permission-mode", "bypassPermissions"] },
      "bypass",
    ],
    [{ tool: "claude", launchMode: "auto" }, "prompting"],
    [{ tool: "codex", launchMode: "yolo" }, "bypass"],
    [{ tool: "codex", launchMode: "default" }, "prompting"],
    [{ tool: "opencode", launchMode: "auto" }, "bypass"],
    [{ tool: "opencode", permissionArgs: ["--auto"] }, "bypass"],
    [{ tool: "opencode", launchMode: "default" }, "prompting"],
    [{ tool: "shell", launchMode: "yolo" }, "prompting"],
    [{ pipeline: { headless: true } }, "bypass"],
    [null, "prompting"],
  ];
  for (const [session, expected] of cases)
    assert.equal(permissionClass(session), expected, JSON.stringify(session));
});
