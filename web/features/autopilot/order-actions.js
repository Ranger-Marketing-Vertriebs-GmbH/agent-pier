// Match the lifecycle routes. A displayed status group can include historical
// aliases ("merged", "done") that do not authorize resource cleanup.
export function orderActions(order) {
  const limits = order.limitations || [];
  const writable =
    !order.cleanup &&
    !["projectUnavailable", "identityMismatch", "unreadableFile", "missingFile"].some(
      (limit) => limits.includes(limit),
    );
  const active = writable && order.managed && order.reportedStatus !== "completed";
  const canStart = active && !limits.includes("sessionOwnershipMismatch");
  return {
    policy: writable,
    pause: Boolean(active && !order.manualPaused),
    resume: Boolean(canStart && order.manualPaused),
    recover: Boolean(
      canStart &&
      (order.session?.status !== "running" || order.deliveryRejected === true),
    ),
    remove: Boolean(
      order.managed &&
      !limits.includes("projectUnavailable") &&
      (order.cleanup ||
        (writable &&
          order.reportedStatus === "completed" &&
          order.hasOpenWork === false)),
    ),
  };
}
