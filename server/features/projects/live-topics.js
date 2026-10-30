// The live `project-groups.changed` signal topic, owner only: `changed` after every
// successful write of the project groups. The projects page reads
// GET /api/project-groups once per `changed`.

const owner = (principal) => principal?.role === "owner";

/** The `project-groups.changed` signal topic definition for LiveHub#define. */
export function projectGroupsChangedTopic() {
  return {
    name: "project-groups.changed",
    mode: "signal",
    authorize: owner,
    scopeKey: () => "owner",
  };
}

/** Signals the topic on `hub` (services.live, absent until it exists). */
export function projectGroupsChanged(hub) {
  hub?.invalidate("project-groups.changed");
}
