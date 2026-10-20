import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

/**
 * The team plugin's before_tool_call write guard, registered against a live
 * TeamBridge of a workflow fixture. `call(target)` is true when a write passes.
 */
export async function nativeWriteGuard(t, f, { registrationMode = "full" } = {}) {
  const listeners = [];
  f.assistants.runtime.child = { pid: process.pid };
  f.assistants.runtime.on = (event, listener) => listeners.push({ event, listener });
  f.assistants.runtime.emitStatus = (state) =>
    listeners.filter((l) => l.event === "status").forEach((l) => l.listener(state));
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: f.assistants.teams,
    generation: () => 1,
  });
  const connection = await bridge.start();
  t.after(() => bridge.close());
  const hooks = [];
  const lifetime = new AbortController(),
    disposers = [];
  const root = path.join(f.dataDir, "workspaces");
  fs.mkdirSync(path.join(root, f.id), { recursive: true });
  plugin.register({
    pluginConfig: { ...connection, workspaces: root },
    registrationMode,
    lifecycle: { signal: lifetime.signal, onDispose: (fn) => disposers.push(fn) },
    registerTool() {},
    on: (name, handler, options) => hooks.push({ name, handler, options }),
  });
  const [hook] = hooks.filter((h) => h.name === "before_tool_call");
  assert.deepEqual(hook.options.matcher, ["write", "edit", "apply_patch"]);
  const agentId = f.store.getAssistant(f.id).runtimeAgentId;
  // The run-time lock hook on OpenClaw's own locked tools: true when the call passes.
  const locked = hooks.find((h) => h.options?.matcher?.includes("exec"));
  const tool = async (toolName, ctx) =>
    !(
      await locked.handler(
        { toolName, params: {} },
        ctx || { agentId, sessionKey: "session" },
      )
    )?.block;
  const call = async (target, { toolName = "write", ctx } = {}) =>
    !(
      await hook.handler(
        { toolName, params: { path: target, content: "Injected" } },
        ctx || { agentId, sessionKey: "session" },
      )
    )?.block;
  // apply_patch with the given hunk lines, inside the Begin/End envelope.
  const patch = async (lines, ctx) =>
    !(
      await hook.handler(
        {
          toolName: "apply_patch",
          params: {
            input:
              typeof lines === "string"
                ? lines
                : ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
          },
        },
        ctx || { agentId, sessionKey: "session" },
      )
    )?.block;
  return {
    bridge,
    call,
    patch,
    tool,
    locked,
    agentId,
    root,
    workspace: path.join(root, f.id),
    retire: async () => {
      lifetime.abort();
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}
