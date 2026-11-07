import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentRunFixture } from "./agent-run-fixture.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { AgentPinboard } from "../../server/features/assistants/agent-pinboard.js";

/**
 * The run fixture's agent with its pinboard (agent-pinboard.js) on the shares it
 * pins through. `f.call(input)` invokes agentpier_pinboard in the latest turn (an
 * owner turn when none ran yet); `f.changes` lists the agents whose pinboard changed.
 */
export async function pinboardFixture(t, options) {
  const f = await agentRunFixture(t, options);
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  const changes = [];
  f.assistants.pinboard = new AgentPinboard({
    assistants: f.assistants,
    onChange: (id) => changes.push(id),
  });
  let latest = null;
  const turn = async (...args) => (latest = await f.turn(...args));
  const invocationOf = (attemptId) => ({
    attemptId,
    toolCallId: randomUUID(),
    assertCurrent() {},
  });
  const call = async (input) => {
    if (!latest) await turn({ kind: "owner" });
    return f.assistants.pinboard.invoke(invocationOf(latest), input);
  };
  // As the plugin prepares and invokes agentpier_pinboard of a run of this session.
  const pin = async (input, runId = "turn-1", key = "session") => {
    const { ticket } = await f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: key,
      toolCallId: randomUUID(),
      action: "pinboard",
      ...(runId ? { runId } : {}),
    });
    return f.bridge.invoke({ ticket, action: "pinboard", input });
  };
  const workspace = path.join(f.workspaces, f.id);
  // Writes a workspace file of the agent; returns its absolute path.
  const file = (name, body = "# Draft\n") => {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return target;
  };
  return {
    ...f,
    pinboard: f.assistants.pinboard,
    changes,
    turn,
    call,
    pin,
    file,
    workspace,
    invocationOf,
  };
}
