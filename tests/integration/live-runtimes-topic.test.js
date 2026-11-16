import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { WRITE_SIGNALED_TOPICS } from "../../server/application/live-wiring.js";
import {
  RUNTIMES_SAMPLE_MS,
  runtimesChanged,
  runtimesTopic,
  runtimesView,
} from "../../server/features/assistants/live-runtime-topics.js";
import { createHermesSwitch } from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";
import { ensureHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";

// The live topic `runtimes`: the runtime list with each runtime's install state, the
// value GET /api/assistant-runtimes answers (ADR 0007).

const owner = { role: "owner" };

function hubOf(t) {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  return { clock, hub };
}

function listen(hub, principal = owner) {
  const frames = [];
  const stop = hub.subscribe(principal, "runtimes", undefined, (f) => frames.push(f));
  return { frames, stop };
}

// Agent services whose optional runtime's install state the test sets.
function agentServices(install = { enabled: false, installed: false }) {
  const services = {
    reads: 0,
    install,
    assistantFeature: { enabled: true, events: new EventEmitter() },
    assistants: {},
    assistantRuntime: null,
    runtimeInstalls: {
      [hermesDescriptor.id]: () => {
        services.reads += 1;
        return structuredClone(services.install);
      },
    },
  };
  return services;
}

const optional = (frame) =>
  frame.data.runtimes.find((runtime) => runtime.install.kind === "optional");

test("the topic's value is the route's body, for the owner alone", async (t) => {
  const { clock, hub } = hubOf(t);
  const services = agentServices({ enabled: true, installed: true, version: "1.2.3" });
  hub.define(runtimesTopic(services));
  const { frames } = listen(hub);
  await clock.advance(0);
  assert.equal(frames[0].type, "snapshot");
  assert.deepEqual(frames[0].data, runtimesView(services));
  assert.equal(optional(frames[0]).ready, true);
  assert.equal(optional(frames[0]).version, "1.2.3");
  assert.equal(runtimesTopic(services).authorize(owner), true);
  assert.equal(runtimesTopic(services).authorize({ role: "user" }), false);
  assert.equal(runtimesTopic(services).authorize(null), false);
});

test("a change of an install state is pushed when it is announced", async (t) => {
  const { clock, hub } = hubOf(t);
  const services = agentServices();
  hub.define(runtimesTopic(services));
  const { frames } = listen(hub);
  await clock.advance(0);
  assert.equal(optional(frames[0]).ready, false);
  services.install = { enabled: true, installed: true };
  // Nothing samples an idle runtime.
  await clock.advance(600000);
  assert.equal(frames.length, 1);
  runtimesChanged(hub);
  await clock.advance(1000);
  assert.equal(frames.at(-1).type, "state");
  assert.equal(optional(frames.at(-1)).ready, true);
  // Without a hub (not listening yet) nothing happens.
  runtimesChanged(undefined);
});

test("an install or update under way is sampled every few seconds, only while watched", async (t) => {
  assert.equal(RUNTIMES_SAMPLE_MS, 3000);
  const { clock, hub } = hubOf(t);
  const services = agentServices({ enabled: true, installed: false, installing: true });
  hub.define(runtimesTopic(services));
  await clock.advance(60000);
  assert.equal(services.reads, 0);
  const { frames, stop } = listen(hub);
  await clock.advance(0);
  assert.equal(services.reads, 1);
  await clock.advance(3000);
  assert.equal(services.reads, 2);
  services.install = { enabled: true, installed: true, installing: false };
  await clock.advance(3000);
  assert.equal(services.reads, 3);
  assert.equal(optional(frames.at(-1)).ready, true);
  // Settled: no further sample.
  await clock.advance(60000);
  assert.equal(services.reads, 3);
  // An update announced later is sampled again until it ends.
  services.install = { enabled: true, installed: true, updating: true };
  runtimesChanged(hub);
  await clock.advance(1000);
  assert.equal(services.reads, 4);
  await clock.advance(3000);
  assert.equal(services.reads, 5);
  stop();
  await clock.advance(60000);
  assert.equal(services.reads, 5);
});

test("agents switched on or off read the list again; without them the topic refuses", async (t) => {
  const { clock, hub } = hubOf(t);
  const services = agentServices();
  hub.define(runtimesTopic(services));
  const { frames } = listen(hub);
  await clock.advance(0);
  services.assistants = null;
  services.assistantFeature.events.emit("stopped");
  await clock.advance(1000);
  assert.deepEqual(frames.slice(1), [{ type: "error", topic: "runtimes" }]);
  services.assistants = {};
  services.install = { enabled: true, installed: true };
  services.assistantFeature.events.emit("started");
  await clock.advance(1000);
  assert.equal(optional(frames.at(-1)).ready, true);
  await assert.rejects(
    async () => runtimesTopic({ assistants: null }).read(owner),
    (error) => error.status === 404 && error.expected === true,
  );
  await assert.rejects(
    async () =>
      runtimesTopic({ assistantFeature: { enabled: true }, assistants: null }).read(
        owner,
      ),
    (error) => error.status === 503 && error.expected === true,
  );
});

test("any successful owner write may have changed the list", () => {
  assert.ok(WRITE_SIGNALED_TOPICS.includes("runtimes"));
});

async function listening(f) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "runtimes" });
  return { live, first: await live.next((frame) => frame.topic === "runtimes", 5000) };
}

test("with agents off the topic answers an error like the route", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await f.request("/api/assistant-runtimes")).status, 404);
  const { live, first } = await listening(f);
  assert.deepEqual(first, { type: "error", topic: "runtimes" });
  live.ws.close();
});

test("the application lists Hermes's install state and pushes the owner's switch", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const install = hermesInstallFixture(t);
  // The switch over the fixture's archives, announcing as the application's does.
  const hermes = createHermesSwitch({
    dataDir: f.dataDir,
    install: (options) => ensureHermesRuntime({ ...install.options, ...options }),
    manifest: install.manifest,
  });
  assert.equal(typeof f.application.hermesRuntime.onChange, "function");
  hermes.onChange = f.application.hermesRuntime.onChange;
  f.application.hermesRuntime = hermes;
  const { live, first } = await listening(f);
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, await (await f.request("/api/assistant-runtimes")).json());
  const [builtin, listed] = first.data.runtimes;
  assert.deepEqual(builtin.install, { kind: "builtin" });
  assert.equal(builtin.ready, true);
  assert.deepEqual(listed.install, { kind: "optional", ...hermes.state() });
  assert.equal(listed.ready, false);
  const ready = live.next(
    (frame) => frame.topic === "runtimes" && optional(frame)?.ready === true,
    20000,
  );
  const enabled = await f.request("/api/assistant-runtime/hermes", {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(enabled.status, 200);
  const pushed = await ready;
  assert.equal(optional(pushed).install.version, install.manifest.version);
  assert.equal(optional(pushed).version, install.manifest.version);
  await hermes.settled();
  live.ws.close();
});
