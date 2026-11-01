// The live topic `previews`, owner only: the value GET /api/previews answers (the open
// previews, the slot range and what the page serves). PreviewService signals it
// through previewsChanged on every open, close and expiry.

const owner = (principal) => principal?.role === "owner";

/** Signals the `previews` topic on `hub` (services.live, absent until it exists). */
export function previewsChanged(hub) {
  hub?.invalidate("previews");
}

/** The `previews` topic definition for LiveHub#define. */
export function previewsTopic(services) {
  return {
    name: "previews",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.previews.view(),
  };
}
