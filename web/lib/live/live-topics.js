// The live topics the browser knows (server/features/live/live-hub.js serves them):
// how a frame is applied (`rows`: ChatSync rows rebuilt with applyListSync, `state`:
// the whole value, `signal`: only `changed`, the caller names the route to read), the
// REST route that answers the same data for `stale` and the fallback, the fallback's
// poll interval, whether the parameter may be left out (`optionalParam`), and whether
// the server samples the topic (then a hidden tab unsubscribes it at once). Pure: the
// Node test stub imports it.
const session = (suffix) => (id) => `/sessions/${encodeURIComponent(id)}/${suffix}`;
const under = (base) => (id) => `${base}/${encodeURIComponent(id)}`;
// `<projectId|*>:<status|*>`: page 1 of the run list with those filters, as slim
// list views.
const runList = (param) => {
  const split = param.indexOf(":");
  const projectId = param.slice(0, split),
    status = param.slice(split + 1);
  return `/pipeline-runs?${new URLSearchParams({
    view: "list",
    page: "1",
    ...(projectId && projectId !== "*" ? { projectId } : {}),
    ...(status && status !== "*" ? { status } : {}),
  })}`;
};

export const liveTopics = Object.freeze({
  state: Object.freeze({ mode: "rows", path: () => "/state", interval: 3000 }),
  "session.requests": Object.freeze({
    mode: "state",
    path: session("requests"),
    interval: 1500,
    sampled: true,
  }),
  "session.models": Object.freeze({
    mode: "state",
    path: session("models"),
    interval: 3000,
    sampled: true,
  }),
  inbox: Object.freeze({ mode: "state", path: () => "/inbox", interval: 5000 }),
  "pipeline.run": Object.freeze({
    mode: "state",
    path: under("/pipeline-runs"),
    interval: 5000,
  }),
  "pipeline.queue": Object.freeze({
    mode: "state",
    path: under("/pipeline-queue"),
    interval: 3000,
  }),
  // The pills' former poll; the counts change only with a run's status or project.
  "pipeline.counts": Object.freeze({
    mode: "state",
    path: (projectId) =>
      projectId
        ? `/pipeline-run-counts?${new URLSearchParams({ projectId })}`
        : "/pipeline-run-counts",
    optionalParam: true,
    interval: 30000,
  }),
  "pipeline.runs": Object.freeze({ mode: "state", path: runList, interval: 5000 }),
  // Later pages and other filters: `changed`, then one read of the caller's route.
  "pipeline.runs.changed": Object.freeze({
    mode: "signal",
    path: null,
    optionalParam: true,
    interval: 5000,
  }),
});

/**
 * The registry entry of `topicId` ("name" or "name:param", split at the first ":"),
 * or null for an unknown name or a parameter the topic does not take or needs. A
 * signal topic's `path` is null.
 */
export function topicInfo(topicId) {
  if (typeof topicId !== "string") return null;
  const split = topicId.indexOf(":");
  const name = split < 0 ? topicId : topicId.slice(0, split);
  const param = split < 0 ? undefined : topicId.slice(split + 1);
  if (!Object.hasOwn(liveTopics, name)) return null;
  const {
    mode,
    path = null,
    interval,
    sampled = false,
    optionalParam = false,
  } = liveTopics[name];
  if (param === "") return null;
  if (!optionalParam && (path?.length > 0 ? !param : param !== undefined)) return null;
  return { name, param, mode, path, interval, sampled };
}
