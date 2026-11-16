import { HermesDreams } from "./dreams/hermes-dreams.js";
import {
  HermesDreamStore,
  diaryListing,
  diaryNote,
} from "./dreams/hermes-dream-store.js";
import { hermesGuard } from "./tools/hermes-tool-guard.js";
import { hermesRoutineApproval } from "./tools/hermes-routine-approvals.js";
import { hermesBrowserUpload } from "./tools/hermes-browser-upload.js";
import { dropExpiredImage, keepGeneratedImage } from "./tools/hermes-generated-images.js";
import { migrateGeneratedImages } from "./tools/hermes-image-migration.js";

// What Hermes Agent brings to features AgentPier shares between runtimes
// (../runtime-services.js): the bridge routes its plugins call, its agents' own
// nightly dreams and the images its agents create. Each is Hermes's own module; this
// list is how feature code reaches them without naming Hermes.

/**
 * The team bridge's routes that Hermes's plugins call (bridge-tool-policies.js), by
 * the URL its compiled plugins post to. `answer(bridge, input)` answers a call;
 * `closed` is the answer of a closed bridge.
 */
const toolRoutes = Object.freeze({
  // A Hermes agent's file changes (team members) and browser calls.
  "/hermes-guard": { answer: hermesGuard, closed: { allow: false } },
  // A Hermes routine run's command the owner is asked about; waits for the answer.
  "/hermes-approval": { answer: hermesRoutineApproval, closed: { allow: false } },
  // A Hermes agent's browser upload of files AgentPier staged for it.
  "/hermes-browser-upload": {
    answer: hermesBrowserUpload,
    closed: {
      ok: false,
      message: "AgentPier is not reachable right now; try again shortly.",
    },
  },
});

/**
 * The nightly dreams of agents that dream by themselves (trait `agentFiles.dreaming:
 * "agent"`): `create({ settings, assistants, clock, keep })` makes the service
 * DreamingBackups ticks, with its store in the dreaming settings' database; the
 * diary functions read that store for the memory view.
 */
const dreams = Object.freeze({
  create: ({ settings, ...options }) =>
    new HermesDreams({ ...options, settings, store: new HermesDreamStore(settings.db) }),
  diaryListing,
  diaryNote,
});

/** The images an agent created in its own home, kept in its chats' file folders. */
const generatedImages = Object.freeze({
  keep: keepGeneratedImage,
  dropExpired: dropExpiredImage,
  migrate: migrateGeneratedImages,
});

export const hermesServices = Object.freeze({ toolRoutes, dreams, generatedImages });
