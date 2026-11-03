// A TicketRuleMonitor over fake trackers: fakeGithub and fakePlane on 127.0.0.1, the
// real ticket, sequence and rule stores on a temp dataDir, a TicketService with the real
// sources and a stub sequence engine (the lock runs the action, a nudge is recorded).
// Never real sessions, tmux, GitHub or Plane.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketService } from "../../server/features/tickets/ticket-service.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { TicketSequenceService } from "../../server/features/tickets/sequence-service.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { TicketRuleMonitor } from "../../server/features/tickets/rule-monitor.js";
import { fakeGithub, fakePlane, githubIssue } from "./ticket-fakes.js";

export const PLANE_PROJECT = "11111111-1111-4111-8111-111111111111";
export const PLANE_LABELS = [
  { id: "l-agent", name: "Agent" },
  { id: "l-bug", name: "bug" },
];
const STATES = [
  { id: "s-todo", name: "Todo", group: "unstarted", sequence: 1 },
  { id: "s-prog", name: "In progress", group: "started", sequence: 10 },
];
export const SESSION = { tool: "claude", accountId: "a1" };

export const labelledIssue = (number, ...labels) =>
  githubIssue(number, { labels: labels.map((name) => ({ name })) });
export const planeItem = (n, labels = []) => ({
  id: `uuid-${n}`,
  sequence_id: n,
  project: PLANE_PROJECT,
  name: `Item ${n}`,
  description_html: `<p>Body ${n}</p>`,
  state: "s-todo",
  labels,
  updated_at: "2026-11-01T10:00:00Z",
});
export const ruleInput = (extra = {}) => ({
  source: "github",
  label: "agent",
  kind: "session",
  paused: false,
  options: { allowMerge: false, session: SESSION },
  ...extra,
});

export async function ruleMonitorFixture(
  t,
  {
    issues = [],
    githubLabels = ["agent"],
    planeItems = [],
    remote = "https://github.com/acme/app.git",
  } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rule-mon-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "app");
  fs.mkdirSync(projectPath);
  const dataDir = path.join(root, "data");
  const githubFailures = {};
  const github = await fakeGithub(t, {
    issues,
    labels: githubLabels,
    failures: githubFailures,
  });
  const plane = await fakePlane(t, {
    projects: [{ id: PLANE_PROJECT, identifier: "AP", name: "AgentPier" }],
    states: STATES,
    labels: PLANE_LABELS,
    items: planeItems,
  });
  // Every call of `now` is one step later.
  let clock = 1_000;
  const now = () => (clock += 1);
  const net = { down: false };
  const fetchImpl = (url, init) =>
    net.down
      ? Promise.reject(new TypeError("fetch failed"))
      : github.fetchImpl(url, init);
  const ticketStore = new TicketStore({ dataDir, now });
  const connection = ticketStore.createConnection({
    name: "Plane",
    baseUrl: plane.baseUrl,
    workspaceSlug: "acme",
    token: "plane-token",
  });
  const rules = new TicketRuleStore({ dataDir, now });
  const store = new TicketSequenceStore({ dataDir, now });
  const tickets = new TicketService({
    store: ticketStore,
    memory: {
      project(id) {
        if (id === "p1") return { id, cwd: projectPath };
        throw Object.assign(new Error("missing"), { status: 404 });
      },
    },
    repositories: {
      listProjects: () => [],
      token: (id) => (id === "c1" ? "gh-token" : null),
      credential: (id) => ({ id, name: "Work", host: "https://github.com" }),
    },
    github: { selections: () => [{ host: "github.com", credentialId: "c1" }] },
    gitRemotes: { read: async () => remote },
    launch: async () => {
      throw new Error("no launch in rule monitor tests");
    },
    chatDelivery: { send: async () => ({ status: "handed-off" }) },
    sessions: { stop: async () => {} },
    pipelines: { start: async () => ({ id: "run-1" }) },
    fetchImpl,
    now,
    // The wiring of createTicketServices (Task 6).
    taken: (projectId, source, key) =>
      store.contains(projectId, source, key) === "active"
        ? "queued"
        : rules.picked(projectId, source, key)
          ? "picked"
          : null,
  });
  const nudges = [];
  const errors = [];
  const engine = {
    exclusive: async (_projectId, action) => action(),
    nudge: async (projectId) => nudges.push(projectId),
    onError: (error, step) => errors.push({ error, step }),
  };
  const sequences = new TicketSequenceService({
    store,
    engine,
    tickets,
    sessions: { list: async () => [] },
    worktrees: {},
    rules,
    now,
  });
  const notified = [];
  const notifications = { notify: async (input) => notified.push(input) };
  const logs = [];
  const monitor = (options = {}) => {
    const made = new TicketRuleMonitor({
      rules,
      tickets,
      sequences,
      notifications,
      now,
      log: (line) => logs.push(line),
      onError: (error) => errors.push({ error }),
      ...options,
    });
    t.after(() => made.close());
    return made;
  };
  const linkPlane = () =>
    tickets.setSources("p1", {
      plane: { connectionId: connection.id, planeProjectId: PLANE_PROJECT },
    });
  const items = () => store.queue("p1")?.items ?? [];
  const keys = () => items().map((item) => item.key);
  const listCalls = () => ({
    github: github.calls.filter((c) => c.method === "GET" && /\/issues\?/.test(c.path))
      .length,
    plane: plane.calls.filter(
      (c) => c.method === "GET" && /\/work-items\/\?/.test(c.path),
    ).length,
  });
  const status = (ruleId) => rules.rule("p1", ruleId).status;
  return {
    root,
    dataDir,
    projectPath,
    github,
    githubFailures,
    plane,
    net,
    ticketStore,
    rules,
    store,
    tickets,
    sequences,
    notified,
    logs,
    errors,
    nudges,
    monitor,
    linkPlane,
    items,
    keys,
    listCalls,
    status,
  };
}
