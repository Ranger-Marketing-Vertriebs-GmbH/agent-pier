// The register signals changes to the order file. Its view also joins live sources.
// The overview follows the global inbox and run list once across all projects.
export function orderSourceTopics(orders, detail) {
  const project = detail && orders[0]?.projectId;
  const topics = new Set([
    project ? `pipeline.runs.changed:${project}` : "pipeline.runs.changed",
  ]);
  if (!detail) topics.add("inbox");
  for (const order of orders) {
    if (order.startReceipts?.some((receipt) => !receipt.confirmed) && order.projectId)
      topics.add(`pipeline.queue:${order.projectId}`);
    if (!detail) continue;
    if (order.session?.id) topics.add(`session.requests:${order.session.id}`);
    for (const run of order.runs ?? []) {
      if (run.resolution === "live") topics.add(`pipeline.run:${run.id}`);
    }
  }
  return [...topics].sort();
}
