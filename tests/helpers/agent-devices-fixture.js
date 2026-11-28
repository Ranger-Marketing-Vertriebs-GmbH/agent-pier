import fs from "node:fs";
import path from "node:path";
import { peers } from "./peer-request-fixture.js";
import { fixtureImage } from "./device-service-fixture.js";
import { memoryDeviceSource } from "./memory-device-source.js";
import { createDevices } from "../../server/application/device-wiring.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

/**
 * A lead with a temporary and two permanent members (peer-request-fixture.js), the
 * real team bridge, and Android devices wired as the application wires them
 * (device-wiring.js createDevices) on a device source in memory:
 *
 * - `lead`, the lead agent, and `agentOf(member)`, `chatOf(member)` for a member
 * - `services` (`devices`, `agentDeviceGrants`, `deviceActions`, `audit.rows`,
 *   `live.signals`), `source`, and `adb`, the adb calls so far; `answers(handler)`
 *   sets what a device answers
 * - `device(name, creator)` creates a device (the owner's by default), and
 *   `assign(agent, device, { manage, create })` is what the owner gave an agent
 * - `call(input, context)`: one agentpier_device call in a fresh turn of the lead's
 *   chat that AgentPier recorded with `context`; `memberCall(member, input,
 *   context)` the same in a member's own chat; `invoke(agent, sessionKey, input)`
 *   one call of any session without starting a turn
 * - `code(promise)`: the tool error code a call fails with, or null
 * - `workspace(agent)`: the agent's workspace folder, created
 */
export async function agentDevicesFixture(t) {
  const f = await peers(t);
  const { dataDir } = f;
  const source = memoryDeviceSource({ image: fixtureImage });
  const sdk = {
    reason: null,
    available: () => sdk.reason,
    manifest: { image: { id: fixtureImage } },
  };
  const services = {
    config: {
      dataDir,
      androidDevices: { service: { sdk, sources: { emulator: source } } },
    },
    assistants: f.assistants,
    audit: { rows: [], append: (row) => services.audit.rows.push(auditEvent(row)) },
    live: { signals: [], invalidate: (name) => services.live.signals.push(name) },
  };
  const { devices, grants, agentGrants, actions } = createDevices(services);
  Object.assign(services, {
    devices,
    sessionDeviceGrants: grants,
    agentDeviceGrants: agentGrants,
    deviceActions: actions,
  });
  t.after(() => devices.shutdown());
  // What the bridge hands a tool: the workflows' scope (assistant-workflows.js).
  f.assistants.workflows = { a: f.assistants, s: services, async close() {} };
  const workspaces = path.join(dataDir, "workspaces");
  f.assistants.runtime.paths = { workspaces };
  const adb = [];
  let handler = () => undefined;
  source.answer = (record, args, options) => {
    adb.push({ id: record.id, args, options });
    return handler(args, options, record);
  };
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  const lead = () => f.store.getAssistant(f.parent.id);
  const agentOf = (member) => f.store.getAssistant(f.fresh(member).assistantId);
  const chatOf = (member) => f.store.getConversation(f.fresh(member).conversationId);
  const invoke = async (agent, sessionKey, input) => {
    const { ticket } = bridge.prepare({
      agentId: agent.runtimeAgentId,
      sessionKey,
      toolCallId: crypto.randomUUID(),
      action: "device",
    });
    return bridge.invoke({ ticket, action: "device", input });
  };
  const call = async (input, context = { kind: "owner" }) => {
    f.settle();
    f.turn("Please check the app on the phone", context);
    try {
      return await invoke(lead(), f.chat.runtimeSessionKey, input);
    } finally {
      f.settle();
    }
  };
  const memberCall = async (member, input, context = { kind: "owner" }) => {
    f.settle();
    f.memberTurn(member, context);
    try {
      return await invoke(agentOf(member), chatOf(member).runtimeSessionKey, input);
    } finally {
      f.settle();
    }
  };
  const code = (promise) =>
    Promise.resolve(promise).then(
      () => null,
      (error) => toolError(error).code,
    );
  return {
    ...f,
    dataDir,
    services,
    devices,
    grants: agentGrants,
    actions,
    source,
    sdk,
    adb,
    answers: (next) => (handler = next),
    bridge,
    lead,
    agentOf,
    chatOf,
    invoke,
    call,
    memberCall,
    code,
    device: (name = "Pixel", creator = { kind: "owner", id: "owner", name: "" }) =>
      devices.create({ name, creator }),
    assign(agent, device, { manage = false, create = false } = {}) {
      const current = agentGrants.get(agent.id);
      return agentGrants.set(agent.id, {
        devices: [
          ...current.devices.filter((entry) => entry.deviceId !== device?.id),
          ...(device ? [{ deviceId: device.id, manage }] : []),
        ],
        create: create || current.create,
      });
    },
    workspace(agent) {
      const folder = path.join(workspaces, agent.id);
      fs.mkdirSync(folder, { recursive: true });
      return folder;
    },
  };
}
