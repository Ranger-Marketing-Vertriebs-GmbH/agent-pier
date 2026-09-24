export const runStatuses = [
  "running",
  "awaiting-human",
  "completed",
  "failed",
  "cancelled",
];
// Order of the status pills in the runs toolbar.
const filterOrder = ["awaiting-human", "running", "failed", "completed", "cancelled"];
const tones = {
  running: "running",
  "awaiting-human": "decision",
  completed: "ok",
  failed: "error",
  cancelled: "neutral",
};

export const runStatusTone = (status) => tones[status] || "neutral";

export function runProject(run) {
  return (run.cwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

export function runProgress(run) {
  const nodes = run.nodes || [];
  const done = nodes.filter((node) => node.status === "passed").length;
  return {
    done,
    total: nodes.length,
    current: nodes.find((node) => node.id === run.currentNodeId),
    percent: nodes.length ? Math.round((done / nodes.length) * 100) : 0,
  };
}

// The newest timestamp the run carries, so the table shows when it last moved.
export function runUpdatedAt(run) {
  const times = [
    run.createdAt,
    run.finishedAt,
    ...(run.nodes || []).flatMap((node) => [node.startedAt, node.finishedAt]),
  ].filter((value) => value && Number.isFinite(Date.parse(value)));
  return times.reduce(
    (latest, value) =>
      !latest || Date.parse(value) > Date.parse(latest) ? value : latest,
    "",
  );
}

// "All statuses" plus every status with runs; the active filter stays visible even
// without runs so it can be cleared.
export function statusFilters(counts, selected) {
  return [
    "",
    ...filterOrder.filter((status) => counts?.[status] > 0 || status === selected),
  ];
}
