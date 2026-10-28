// The live artifact topics, owner only. `artifacts.usage` is the storage usage, the
// value GET /api/artifacts/usage answers. `artifacts.changed` sends `changed` on any
// change of the artifact index (published, replaced, pinned, deleted, a session
// retired, a project moved) and of its stored files (cleanup): the list and search
// pages are per-client queries with free text and paging, so each reads its own
// GET /api/artifacts?… once per `changed` instead of being pushed.
// ArtifactStore's onChange signals both through artifactsChanged.

const owner = (principal) => principal?.role === "owner";

/** Signals both artifact topics on `hub` (services.live, absent until it exists). */
export function artifactsChanged(hub) {
  hub?.invalidate("artifacts.usage");
  hub?.invalidate("artifacts.changed");
}

/** The `artifacts.usage` topic definition for LiveHub#define. */
export function artifactsUsageTopic(services) {
  return {
    name: "artifacts.usage",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.artifacts.usage(),
  };
}

/** The `artifacts.changed` signal topic definition for LiveHub#define. */
export function artifactsChangedTopic() {
  return {
    name: "artifacts.changed",
    mode: "signal",
    authorize: owner,
    scopeKey: () => "owner",
  };
}
