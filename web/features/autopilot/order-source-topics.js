// The register signals changes to the order file. Its view also joins live sources.
// One project uses its scoped signal. A cross-project overview shares an aggregate
// subscription so the number of open projects cannot exhaust the socket limit.
export function orderSourceTopics(orders, detail) {
  if (!orders.length) return [];
  const projects = new Set(orders.map((order) => order.projectId));
  const project = projects.size === 1 && orders[0].projectId;
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
