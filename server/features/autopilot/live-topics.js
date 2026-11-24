// The register spans repositories. A project view needs only changes in its own
// Git common directory, even when Composer writes from another worktree.
export function autopilotOrdersTopic() {
  return {
    name: "autopilot.orders.changed",
    mode: "signal",
    param: /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/,
    paramOptional: true,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
  };
}

export function autopilotChanged(hub, projectId) {
  hub?.invalidateWhere(
    "autopilot.orders.changed",
    (param) => !param || param === projectId,
  );
}
