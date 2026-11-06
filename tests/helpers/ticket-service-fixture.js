// Fixtures of the ticket-service integration tests (fake GitHub/Plane, launch, delivery).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketService } from "../../server/features/tickets/ticket-service.js";
import { fakeGithub, fakePlane, githubIssue } from "./ticket-fakes.js";

export const planeProjectId = "11111111-1111-4111-8111-111111111111";
export const otherPlaneProjectId = "22222222-2222-4222-8222-222222222222";
export const STATES = [
  { id: "s-todo", name: "Todo", group: "unstarted", sequence: 1 },
  { id: "s-prog", name: "In progress", group: "started", sequence: 10 },
  { id: "s-done", name: "Done", group: "completed", sequence: 30 },
];
export const planeItem = (n, extra = {}) => ({
  id: `uuid-${n}`,
  sequence_id: n,
  project: planeProjectId,
  name: `Item ${n}`,
  description_html: `<p>Body ${n}</p>`,
  state: "s-todo",
  labels: [],
  updated_at: `2026-11-0${n}T10:00:00Z`,
  ...extra,
});

export async function setup(
  t,
  {
    githubFailures = {},
    planeFailures = {},
    tool = "claude",
    deliver,
    settled,
    taken,
  } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-ticket-svc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "app");
  const otherPath = path.join(root, "other");
  fs.mkdirSync(projectPath);
  fs.mkdirSync(otherPath);
  const github = await fakeGithub(t, {
    issues: [
      githubIssue(7, { title: "Fix login", updated_at: "2026-11-05T10:00:00Z" }),
      githubIssue(8, { labels: [{ name: "bug" }] }),
    ],
    failures: githubFailures,
  });
  const plane = await fakePlane(t, {
    projects: [
      { id: planeProjectId, identifier: "AP", name: "AgentPier" },
      { id: otherPlaneProjectId, identifier: "XY", name: "Other" },
    ],
    states: STATES,
    items: [planeItem(3), planeItem(4, { state: "s-done" })],
    failures: planeFailures,
  });
  const store = new TicketStore({ dataDir: path.join(root, "data") });
  const connection = store.createConnection({
    name: "Plane",
    baseUrl: plane.baseUrl,
    workspaceSlug: "acme",
    token: "plane-token",
  });
  const launched = [];
  const sent = [];
  const engineStarts = [];
  const hubSignals = [];
  const stopped = [];
  let sessionCount = 0;
  const service = new TicketService({
    store,
    memory: {
      project(id) {
        if (id === "p1") return { id, cwd: projectPath };
        if (id === "p2") return { id, cwd: otherPath };
        throw Object.assign(new Error("missing"), { status: 404 });
      },
    },
    repositories: {
      listProjects: () => [],
      token: (id) => (id === "c1" ? "gh-token" : null),
      credential: (id) => ({ id, name: "Work", host: "https://github.com" }),
    },
    github: { selections: () => [{ host: "github.com", credentialId: "c1" }] },
    gitRemotes: {
      read: async (cwd) =>
        cwd === projectPath
          ? "https://github.com/acme/app.git"
          : "git@gitlab.com:x/y.git",
    },
    async launch(body, login, trusted) {
      trusted.validateAccount?.({ id: body.accountId, tool });
      // Let a parallel start reach its lock while this one is still launching.
      await new Promise((resolve) => setTimeout(resolve, 20));
      sessionCount += 1;
      const session = {
        id: `s${sessionCount}`,
        accountId: body.accountId ?? "a1",
        tool,
        createdAt: 1,
      };
      launched.push({ body, login, trusted, session });
      return session;
    },
    chatDelivery: {
      settled,
      async send(id, body) {
        sent.push({ id, ...body });
        return deliver ? deliver(sent.length) : { status: "handed-off" };
      },
    },
    sessions: { stop: async (id) => stopped.push(id) },
    pipelines: {
      async start(input, options) {
        engineStarts.push({ input, options });
        return { id: "run-1" };
      },
    },
    live: () => ({
      invalidate: (name, param) =>
        hubSignals.push(param === undefined ? name : `${name}:${param}`),
    }),
    fetchImpl: github.fetchImpl,
    ...(taken ? { taken } : {}),
  });
  const linkPlane = (id = "p1") =>
    service.setSources(id, {
      plane: { connectionId: connection.id, planeProjectId },
    });
  return {
    service,
    store,
    github,
    plane,
    connection,
    launched,
    sent,
    engineStarts,
    hubSignals,
    stopped,
    projectPath,
    linkPlane,
  };
}
