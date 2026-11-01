// The live topic `previews`, owner only: the value GET /api/previews answers (the open
// previews, the slot range and what the page serves). PreviewService invalidates it on
// every open, close and expiry.

const owner = (principal) => principal?.role === "owner";

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
