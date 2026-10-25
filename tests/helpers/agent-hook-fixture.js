import { routineFixture } from "./native-routines-fixture.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

// routineFixture (an agent with reminders on, a paired Telegram chat in German and
// an in-memory cron store), a workflows stub without grants, and the hook service
// with a Gateway event hub. `f.pushes` collects push notices, `f.audits` the audit
// events as the log keeps them.
export function hookFixture(t) {
  const f = routineFixture(t);
  const audits = [];
  f.assistants.audit = { append: (event) => audits.push(auditEvent(event)) };
  f.assistants.workflows = {
    access: { get: () => ({ projectIds: [], sshAccesses: [] }), sshHosts: () => [] },
    folders: { ownAndShared: () => ({}) },
  };
  f.assistants.gatewayEvents = new GatewayEventHub();
  f.assistants.routines = f.routines;
  const hooks = new AgentHooks({
    reminders: f.reminders,
    routines: f.routines,
    notifications: { notify: async (input) => f.pushes.push(input) },
    addresses: (id) => ({ local: `http://127.0.0.1:4380/hooks/${id}` }),
  });
  // The sweep timer of unsettled events (agent-hook-runs.js).
  t.after(() => hooks.runs.close());
  const agent = f.store.getAssistant(f.id);
  return { ...f, hooks, audits, runtimeAgentId: agent.runtimeAgentId };
}
// A stored hook (deliver takes the stored record, as the endpoint reads it).
export function makeHook(f, input = {}) {
  const { hook } = f.hooks.create(f.id, { name: "Zabbix", sender: "zabbix01", ...input });
  return f.hooks.store.get(hook.id);
}
export const body = (text, extra = {}) => ({
  text,
  json: JSON.parse(text),
  contentType: "application/json",
  size: Buffer.byteLength(text),
  headers: {},
  source: "local",
  ...extra,
});
export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const event = (f, hook, eventId) => f.hooks.events.find(hook.id, eventId);
export const done = (job, extra = {}) => ({
  jobId: job,
  runAtMs: 1000,
  status: "ok",
  summary: "Disk on db1 is full; I found the log that grew.",
  deliveryStatus: "delivered",
  ...extra,
});
export const deliveries = (f) =>
  f.audits.filter((a) => a.details.kind === "hook-delivery");
