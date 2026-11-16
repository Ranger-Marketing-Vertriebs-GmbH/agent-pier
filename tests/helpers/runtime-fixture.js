import { restartRequired } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { defineRuntimeDescriptor } from "../../server/features/assistants/runtimes/agent-runtime.js";

// A runtime only tests know (ADR 0007, step 4): it describes advanced settings of its
// own, which no shipped runtime does yet. Its fields cover every field type and every
// way a change applies.
export const fixtureFields = Object.freeze([
  { id: "delegation", type: "toggle", default: false, apply: "nextTurn" },
  {
    id: "effort",
    type: "select",
    options: ["low", "high"],
    default: "low",
    apply: "live",
  },
  {
    id: "workers",
    type: "number",
    min: 1,
    max: 8,
    step: 1,
    unit: "count",
    default: 2,
    apply: "restart",
  },
  { id: "greeting", type: "text", default: "", apply: "live" },
]);

export const fixtureSurface = Object.freeze({
  id: "tuning",
  slot: "hub.runtime.advanced",
  kind: "described",
  scope: "host",
  fields: fixtureFields,
});

export const fixtureDescriptor = defineRuntimeDescriptor({
  id: "fixture",
  name: "Fixture Runtime",
  shortName: "Fixture",
  traits: { host: { process: "perAgent", install: "optional" } },
  surfaces: [fixtureSurface],
});

/**
 * The fixture runtime as advanced-config.js lists a runtime (runtime-for.js
 * `advancedRuntimes`): its descriptor and how its host takes advanced settings.
 * `taken`: the shared settings it takes (`{ runtime, list, byId }`), none by default;
 * `host`: what replaces parts of its host port. Its own `storeOwn` stores at once,
 * except a `restart` field while it runs: that asks first, with its own question
 * naming its own agents (`affected`), and restarts its own host
 * (`restart(operation)`), undoing the stored value when the restart fails: a runtime
 * with a host per agent gets no restart of the shared agent service from AgentPier.
 * `applied` collects what reached the host: `[apply, fieldId, value]`; `contexts`
 * the context of each own write. `process` replaces its trait `host.process`.
 */
export function fixtureRuntime({
  running = true,
  taken = null,
  restart = async (operation) => operation(),
  applied = [],
  contexts = [],
  affected = { agents: [{ id: "f1", name: "Fix" }], teamMembers: 0 },
  process = fixtureDescriptor.traits.host.process,
  host = {},
} = {}) {
  return {
    id: fixtureDescriptor.id,
    name: fixtureDescriptor.name,
    shortName: fixtureDescriptor.shortName,
    process,
    descriptor: fixtureDescriptor,
    host: {
      settings: () => taken,
      status: () => ({
        enabled: true,
        running,
        settled: true,
        version: "1.0.0",
        qualified: true,
      }),
      async storeOwn(field, value, context) {
        const { confirmed, persist, revert } = context;
        contexts.push(context);
        if (field.apply !== "restart" || !running) {
          persist();
          applied.push([field.apply, field.id, value]);
          return;
        }
        if (!confirmed) throw restartRequired("advancedRestartRequired", affected);
        try {
          await restart(persist);
          applied.push([field.apply, field.id, value]);
        } catch (error) {
          revert();
          throw error;
        }
      },
      ...host,
    },
  };
}

/**
 * The fixture runtime's compiler: its configuration from the desired state and its
 * own advanced settings (`settings`, runtime-settings.js ownSettings). Pure.
 */
export const fixtureCompiler = Object.freeze({
  compile: ({ desired, settings }) => ({
    agents: desired.agents.map((agent) => agent.id),
    delegation: settings.delegation,
    effort: settings.effort,
    workers: settings.workers,
    greeting: settings.greeting,
  }),
});
