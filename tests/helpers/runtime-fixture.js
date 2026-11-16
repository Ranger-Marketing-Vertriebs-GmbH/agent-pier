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
