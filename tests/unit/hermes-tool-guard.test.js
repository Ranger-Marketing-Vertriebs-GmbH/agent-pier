import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesGuard } from "../../server/features/assistants/hermes-tool-guard.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import {
  browserRefusals,
  writeRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";

// The Hermes team plugin's guard (hermes-tool-guard.js) applies the OpenClaw tool
// guard's rules to Hermes's own tools: the browser asks AgentBrowsers, a file change
// stays in the agent's folder and is allowed only as the bridge allows the turn.
function guardBridge(t, { allow = true, browser = { allow: true } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = { id: "m1", runtime: "hermes", runtimeAgentId: "ap-m1" };
  const calls = [];
  const bridge = {
    assistants: { runtime: supervisor },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    toolPolicy: async (input) => {
      calls.push(["tool", input]);
      return { allow };
    },
    browserPolicy: async (input) => {
      calls.push(["browser", input]);
      return browser;
    },
  };
  const workspace = path.join(dataDir, "assistants", "hermes", "workspaces", "ap-m1");
  return { bridge, calls, workspace };
}
const call = (toolName, args, extra = {}) => ({
  agentId: "ap-m1",
  sessionKey: "agent:ap-m1:hermes:s1",
  toolName,
  args,
  ...extra,
});

test("a write inside the agent's folder asks the bridge for the turn", async (t) => {
  const { bridge, calls } = guardBridge(t);
  assert.deepEqual(
    await hermesGuard(bridge, call("write_file", { path: "notes.txt", content: "x" })),
    { allow: true },
  );
  assert.deepEqual(calls, [
    [
      "tool",
      {
        agentId: "ap-m1",
        sessionKey: "agent:ap-m1:hermes:s1",
        toolName: "write",
        path: "notes.txt",
      },
    ],
  ]);
  // A V4A patch names each file it changes.
  calls.length = 0;
  const patch =
    "*** Begin Patch\n*** Add File: a.md\n+x\n*** Update File: b/c.md\n@@\n-y\n+z\n*** End Patch";
  await hermesGuard(bridge, call("patch", { mode: "patch", patch }));
  assert.deepEqual(
    calls.map(([, input]) => [input.toolName, input.path]),
    [
      ["apply_patch", "a.md"],
      ["apply_patch", "b/c.md"],
    ],
  );
});

test("a write the turn may not make, or outside the folder, is refused", async (t) => {
  const refused = guardBridge(t, { allow: false });
  assert.deepEqual(
    await hermesGuard(refused.bridge, call("patch", { path: "a.md", old_string: "a" })),
    { allow: false, message: writeRefusals.owner },
  );
  const { bridge, calls, workspace } = guardBridge(t);
  for (const [args, message] of [
    [{ path: "../ap-other/x.md" }, writeRefusals.outside],
    [{ path: "/etc/hosts" }, writeRefusals.outside],
    [{ path: path.join(workspace, "..", "ap-other", "x") }, writeRefusals.outside],
    [{ path: "AGENTS.md" }, writeRefusals.bootstrap],
    [{ path: "skills/x/SKILL.md" }, writeRefusals.bootstrap],
    [{}, writeRefusals.outside],
  ])
    assert.deepEqual(await hermesGuard(bridge, call("write_file", args)), {
      allow: false,
      message,
    });
  // Without a session no turn is known.
  assert.deepEqual(
    await hermesGuard(bridge, {
      agentId: "ap-m1",
      toolName: "write_file",
      args: { path: "a" },
    }),
    { allow: false, message: writeRefusals.unauthorized },
  );
  assert.deepEqual(calls, []);
  // An absolute path into its own folder is its own.
  assert.deepEqual(
    await hermesGuard(
      bridge,
      call("write_file", { path: path.join(workspace, "ok.md") }),
    ),
    { allow: true },
  );
});

test("browser calls follow AgentBrowsers' answer; other tools pass", async (t) => {
  const { bridge, calls } = guardBridge(t, {
    browser: { allow: false, reason: "visibleLimit" },
  });
  assert.deepEqual(await hermesGuard(bridge, call("browser_navigate", { url: "x" })), {
    allow: false,
    message: browserRefusals.visibleLimit,
  });
  assert.deepEqual(calls, [
    [
      "browser",
      { agentId: "ap-m1", sessionKey: "agent:ap-m1:hermes:s1", action: "navigate" },
    ],
  ]);
  assert.deepEqual(await hermesGuard(bridge, call("read_file", { path: "x" })), {
    allow: true,
  });
  // An agent that is not a Hermes agent of this AgentPier gets nothing.
  assert.equal(
    (await hermesGuard(bridge, { ...call("browser_click", {}), agentId: "ap-x" })).allow,
    false,
  );
  await assert.rejects(hermesGuard(bridge, { ...call("x", {}), extra: 1 }), {
    key: "invalid",
  });
});
