// The live `inbox` topic: everything waiting for the owner, the same value
// GET /api/inbox answers. OwnerInbox announces every change of the waiting set (its
// sources call changed(), and its timer catches expiry while anyone listens), so the
// topic only reads again on those announcements. Owner only.

/** The topic definition for LiveHub#define. */
export function inboxTopic(services) {
  return {
    name: "inbox",
    mode: "state",
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    // Without the inbox service there is nothing to read and nothing to follow.
    read: async () => (services.inbox ? services.inbox.snapshot() : null),
    watch({ invalidate }) {
      return services.inbox ? services.inbox.subscribe(() => invalidate()) : undefined;
    },
  };
}
