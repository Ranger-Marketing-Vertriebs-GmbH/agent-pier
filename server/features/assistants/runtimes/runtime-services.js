import { assistantProblem } from "../assistant-validation.js";
import { hermesServices } from "./hermes/services.js";

// What runtimes bring to features AgentPier shares between them, beside the port of
// agent-runtime.js: bridge routes their own plugins call, dreams their agents run by
// themselves, images their agents create in a home of their own. Each runtime lists
// its parts in `<id>/services.js`; feature code asks here and names no runtime
// (docs/adr/0007-runtime-descriptor.md, decision 7). OpenClaw lists none: its tool
// hooks, its dreaming and its workspaces are the shared ones feature code knows.
//
// Read at each call, never when this module loads: a runtime's parts import feature
// modules that import this one.
const parts = () => [hermesServices];
// The part `name` of the first runtime that brings one. Each part exists once today;
// a second runtime bringing the same part needs a choice by the agent's runtime here.
const part = (name) => parts().find((services) => services[name])?.[name];

/**
 * The team bridge's routes runtimes answer themselves, by URL: `{ [url]: { answer(
 * bridge, input), closed } }`, `closed` being the answer of a closed bridge.
 */
export const runtimeToolRoutes = () =>
  Object.assign({}, ...parts().map((services) => services.toolRoutes));

/**
 * The service that dreams for agents dreaming by themselves (trait
 * `agentFiles.dreaming: "agent"`), made for DreamingBackups: `{ tick(now), store,
 * onChange }`; null when no runtime brings one. `options`: `{ settings, assistants,
 * clock, keep }`.
 */
export const agentDreams = (options) => part("dreams")?.create(options) ?? null;

/**
 * The diary such an agent's dreams keep in `store` (agentDreams(...).store), as the
 * memory view lists and reads it; null without an entry or a store.
 */
export const dreamDiary = Object.freeze({
  listing: (store, id) => part("dreams")?.diaryListing(store, id) ?? null,
  note: (store, id) => part("dreams")?.diaryNote(store, id) ?? null,
});

/**
 * Images an agent created in a home of its own: `keep(assistants, agent,
 * conversation, name)` copies one into the chat's file folder (refused as invalid
 * when no runtime keeps any), `dropExpired(folder, entry, now)` removes a copy past
 * its time and says whether it did, `migrate(attachments, assistantId)` moves what an
 * older AgentPier left and resolves with how many.
 */
export const generatedImages = Object.freeze({
  keep: async (...args) => {
    const images = part("generatedImages");
    if (!images) throw assistantProblem("invalid");
    return images.keep(...args);
  },
  dropExpired: async (...args) =>
    (await part("generatedImages")?.dropExpired(...args)) ?? false,
  migrate: async (...args) => (await part("generatedImages")?.migrate(...args)) ?? 0,
});
