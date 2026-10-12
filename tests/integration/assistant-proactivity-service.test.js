import test from "node:test";
import assert from "node:assert/strict";
import { shellService } from "../helpers/assistant-shell-service.js";

const heartbeat = {
  enabled: true,
  interval: "2h",
  start: 8,
  end: 18,
  timeZone: "Europe/Berlin",
};
const revision = (f, agent) => f.store.getAssistant(agent.id).revision;
const proactivityAudit = (f) =>
  f.audit.filter((e) => e.details.kind === "proactivity").map((e) => e.details);

function withHeartbeats(f, { paired = true } = {}) {
  const synced = [];
  f.service.reminders = {
    disable: async () => {},
    close: async () => {},
    heartbeats: {
      requireChannel() {
        if (!paired)
          throw Object.assign(Error("unpaired"), {
            status: 409,
            key: "heartbeatChannelRequired",
          });
      },
      sync: async (id) => synced.push(id),
    },
  };
  return synced;
}

test("enabling check-ins needs memory; switching memory off is refused while they are on", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  const synced = withHeartbeats(f);
  await assert.rejects(
    f.service.update(home.id, { heartbeat }, revision(f, home)),
    (error) => error.status === 409 && error.key === "heartbeatMemoryRequired",
  );
  assert.equal(f.store.getAssistant(home.id).heartbeat, undefined, "nothing saved");
  // Memory switched on in the same save is enough.
  await f.service.update(
    home.id,
    { heartbeat, capabilities: { memory: true, reminders: false } },
    revision(f, home),
  );
  assert.deepEqual(synced, [home.id]);
  await assert.rejects(
    f.service.update(
      home.id,
      { capabilities: { memory: false, reminders: false } },
      revision(f, home),
    ),
    (error) => error.status === 409 && error.key === "heartbeatMemoryRequired",
  );
  // Switching both off together is fine.
  await f.service.update(
    home.id,
    {
      heartbeat: { ...heartbeat, enabled: false },
      capabilities: { memory: false, reminders: false },
    },
    revision(f, home),
  );
  assert.equal(f.store.getAssistant(home.id).capabilities.memory, false);
});

test("an agent created with check-ins settings starts with them off and unaudited", async (t) => {
  const f = shellService(t);
  const created = await f.service.create({
    name: "Fresh",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: true, reminders: false },
    heartbeat,
  });
  assert.equal(created.heartbeat.enabled, false);
  assert.deepEqual(proactivityAudit(f), []);
});

test("enabling check-ins needs a paired chat; a saved change schedules the job", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  const synced = withHeartbeats(f, { paired: false });
  await assert.rejects(
    f.service.update(
      home.id,
      { heartbeat, capabilities: { memory: true, reminders: false } },
      revision(f, home),
    ),
    (error) => error.status === 409 && error.key === "heartbeatChannelRequired",
  );
  assert.equal(f.store.getAssistant(home.id).heartbeat, undefined, "nothing saved");
  assert.equal(f.store.getAssistant(home.id).capabilities, undefined);
  assert.deepEqual(synced, []);
  const paired = withHeartbeats(f);
  await f.service.update(
    home.id,
    { heartbeat, capabilities: { memory: true, reminders: false } },
    revision(f, home),
  );
  assert.deepEqual(f.store.getAssistant(home.id).heartbeat, heartbeat);
  assert.deepEqual(paired, [home.id]);
  // An unchanged form neither schedules nor audits anything again.
  await f.service.update(home.id, { heartbeat, name: "Renamed" }, revision(f, home));
  assert.deepEqual(paired, [home.id]);
  // Switching off never needs a chat.
  withHeartbeats(f, { paired: false });
  await f.service.update(
    home.id,
    { heartbeat: { ...heartbeat, enabled: false } },
    revision(f, home),
  );
  assert.deepEqual(proactivityAudit(f), [
    { kind: "proactivity", fields: ["heartbeat"], heartbeat: true },
    { kind: "proactivity", fields: ["heartbeat"], heartbeat: false },
  ]);
  // Older clients send neither field and keep the stored values.
  await f.service.update(
    home.id,
    { capabilities: { memory: true, reminders: false } },
    revision(f, home),
  );
  assert.equal(f.store.getAssistant(home.id).heartbeat.interval, "2h");
});

test("a capability change re-syncs check-ins so reminders switching off cannot pause them", async (t) => {
  const f = shellService(t);
  const [home] = f.agents;
  const synced = withHeartbeats(f);
  await f.service.update(
    home.id,
    { heartbeat, capabilities: { memory: true, reminders: true } },
    revision(f, home),
  );
  await f.service.update(
    home.id,
    { capabilities: { memory: true, reminders: false } },
    revision(f, home),
  );
  assert.deepEqual(synced, [home.id, home.id]);
});
