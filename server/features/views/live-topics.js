// The live `views` state topic, owner only: the whole views document, pushed after
// every successful write. The sidebar and the view pages read it instead of polling.

const owner = (principal) => principal?.role === "owner";

/** The `views` state topic definition for LiveHub#define. */
export function viewsTopic(services) {
  return {
    name: "views",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.views.list(),
  };
}

/** Invalidates the topic on `hub` (services.live, absent until it exists). */
export function viewsChanged(hub) {
  hub?.invalidate("views");
}
