// The live topics the browser knows (server/features/live/live-hub.js serves them):
// how a frame is applied (`rows`: ChatSync rows rebuilt with applyListSync, `state`:
// the whole value, `signal`: only `changed`, the caller names the route to read), the
// REST route that answers the same data for `stale` and the fallback, the fallback's
// poll interval, the `sections` a topic's value adds from routes of their own, whether
// the parameter may be left out (`optionalParam`) or a signal
// topic needs one (`paramRequired`), and whether the server samples the topic (then a
// hidden tab unsubscribes it at once). Pure: the Node test stub imports it.
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
  // The menu-hint sources, at the start page's former poll. The server samples the
  // problems and the agent update status (every 60 s), not the summary.
  "settings.summary": Object.freeze({
    mode: "state",
    path: () => "/settings/summary",
    interval: 30000,
  }),
  "connections.problems": Object.freeze({
    mode: "state",
    path: () => "/connections/problems",
    interval: 30000,
    sampled: true,
  }),
  // The agent list (sidebar, agents page, settings) with the agent runtime's status,
  // which its own route answers: the value is `{...list, runtime}`.
  "agent.list": Object.freeze({
    mode: "rows",
    path: () => "/assistants",
    sections: Object.freeze({ runtime: () => "/assistant-runtime" }),
    interval: 5000,
  }),
  // An agent's details, at the settings' and chat's former polls. Actions and team
  // coding requests read the same route; the pushed coding requests carry the team
  // requests only (the hook filters both the same way). The channels route lists
  // every agent's channels; the pushed value only this agent's.
  "agent.actions": Object.freeze({
    mode: "state",
    path: (id) => `/assistants/${encodeURIComponent(id)}/actions`,
    interval: 3000,
  }),
  "agent.coding-requests": Object.freeze({
    mode: "state",
    path: (id) => `/assistants/${encodeURIComponent(id)}/actions`,
    interval: 3000,
  }),
  "agent.channels": Object.freeze({
    mode: "state",
    path: (_id) => "/assistant-channels",
    interval: 2000,
  }),
  // The Gateway's cron jobs are sampled by the server while a visible tab watches.
  "agent.reminders": Object.freeze({
    mode: "state",
    path: (id) => `/assistants/${encodeURIComponent(id)}/reminders`,
    interval: 10000,
    sampled: true,
  }),
  // The bot's state is sampled by the server while a visible tab watches.
  "agent.senders": Object.freeze({
    mode: "state",
    path: under("/assistant-telegram-senders"),
    interval: 5000,
    sampled: true,
  }),
  "runtime.updates": Object.freeze({
    mode: "state",
    path: () => "/assistant-runtime/updates",
    interval: 30000,
    sampled: true,
  }),
  // An operations job; a running one is sampled (a release helper writes it).
  "job.operation": Object.freeze({
    mode: "state",
    path: under("/operations/jobs"),
    interval: 1500,
    sampled: true,
  }),
  // One tool's installation and the installer's `busy`, pushed on every job write.
  "job.tool": Object.freeze({
    mode: "state",
    path: (tool) => `/tool-installations?${new URLSearchParams({ tool })}`,
    interval: 1500,
  }),
  // The managed REA tool (`current`); a running job is sampled every second.
  "job.rea": Object.freeze({
    mode: "state",
    path: (_current) => "/rea",
    interval: 1000,
    sampled: true,
  }),
  // A packaged MCP server's package and its last job, pushed on every job write.
  "job.mcp-package": Object.freeze({
    mode: "state",
    path: (id) => `/mcp-servers/${encodeURIComponent(id)}/package`,
    interval: 2000,
  }),
  // A CLI account's plugins (default catalog); start and end of a change are pushed.
  "job.plugins": Object.freeze({
    mode: "state",
    path: (id) => `/accounts/${encodeURIComponent(id)}/plugins`,
    interval: 2000,
  }),
  // A session's SSH hosts and tools; starting tools are sampled every 1.5 s.
  "job.ssh-tools": Object.freeze({
    mode: "state",
    path: session("ssh-accesses"),
    interval: 1500,
    sampled: true,
  }),
  // The latest ChatGPT sign-in of the agents (`current`), pushed on every change.
  "job.chatgpt-login": Object.freeze({
    mode: "state",
    path: (_current) => "/assistant-model-login/current",
    interval: 1000,
  }),
  // Whether and how a session can be reloaded; sampled every 1.5 s.
  "session.reload": Object.freeze({
    mode: "state",
    path: session("reload"),
    interval: 1500,
    sampled: true,
  }),
  // A file scope's job envelopes (`global` or `session:<id>`), the first page of its
  // jobs, pushed on every job write. Entry and result pages stay REST: the explorer
  // reads them when a job's `updatedAt` changes.
  "files.jobs": Object.freeze({
    mode: "state",
    path: (scope) =>
      scope === "global"
        ? "/files/jobs"
        : `/sessions/${encodeURIComponent(scope.replace(/^session:/, ""))}/files/explorer/jobs`,
    interval: 1500,
  }),
  // A session's chat deliveries: `changed`, then the chat reads its pending ones.
  "session.deliveries": Object.freeze({
    mode: "signal",
    path: null,
    paramRequired: true,
    interval: 2500,
  }),
  // An old release's session migration plan, sampled every 3 s.
  "operations.release-sessions": Object.freeze({
    mode: "state",
    path: (version) =>
      `/operations/releases/cleanup/${encodeURIComponent(version)}/sessions`,
    interval: 3000,
    sampled: true,
  }),
  "artifacts.usage": Object.freeze({
    mode: "state",
    path: () => "/artifacts/usage",
    interval: 5000,
  }),
  // The list and search pages: `changed`, then one read of the caller's query.
  "artifacts.changed": Object.freeze({ mode: "signal", path: null, interval: 5000 }),
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
    sections = null,
    optionalParam = false,
    paramRequired = false,
  } = liveTopics[name];
  if (param === "") return null;
  const takesParam = paramRequired || path?.length > 0;
  if (!optionalParam && (takesParam ? !param : param !== undefined)) return null;
  return { name, param, mode, path, interval, sampled, sections };
}

/**
 * A topic's value over REST: `read(path)` of its route and, for each of `sections`
 * (topicInfo), that section's route added under its name. One failed read fails all.
 */
export async function readTopicValue(path, sections, read, param) {
  const named = Object.entries(sections || {});
  const [value, ...parts] = await Promise.all([
    read(path),
    ...named.map(([, route]) => read(route(param))),
  ]);
  if (!named.length) return value;
  return { ...value, ...Object.fromEntries(named.map(([name], i) => [name, parts[i]])) };
}
