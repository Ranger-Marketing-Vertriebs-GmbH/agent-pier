// Builds a TicketSequenceEngine over fakes: a temp git repo with a bare origin, the
// sequence and ticket stores on a temp dataDir, a fake GitHub pull request server, fake
// ticket sources, sessions, chat delivery, run queue, pipelines and push. Never real
// sessions, tmux, GitHub or Plane.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketService } from "../../server/features/tickets/ticket-service.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { TicketSequenceEngine } from "../../server/features/tickets/sequence-engine.js";
import { TicketWorktrees } from "../../server/features/tickets/ticket-worktree.js";
import assert from "node:assert/strict";
import { fakeGithubPulls, githubPull } from "./ticket-fakes.js";

export const T0 = Date.parse("2026-11-03T10:00:00Z");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
export const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

function repo(dir) {
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const source = path.join(dir, "app");
  git(dir, "init", "--bare", "-b", "main", origin);
  git(dir, "clone", origin, seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "first");
  git(seed, "push", "origin", "HEAD:main");
  git(dir, "clone", origin, source);
  return source;
}

export function issueTicket(key, extra = {}) {
  const number = Number(/#(\d+)$/.exec(key)?.[1] ?? 0);
  return {
    source: "github",
    key,
    number,
    id: String(number),
    title: `Fix thing ${number}`,
    body: `Body ${number}`,
    url: `https://github.com/acme/app/issues/${number}`,
    labels: [],
    state: "open",
    updatedAt: "2026-11-01T10:00:00Z",
    ...extra,
  };
}

/** Fake GitHub ticket source recording get/markInProgress/markDone. */
function fakeSources(calls, { getError } = {}) {
  return {
    github: {
      id: "github",
      async get(_access, key) {
        calls.push({ name: "get", key });
        const error = getError?.(key);
        if (error) throw error;
        return issueTicket(key);
      },
      async markInProgress(_access, ticket, options) {
        calls.push({ name: "markInProgress", key: ticket.key, options });
        return { state: "done" };
      },
      async markDone(_access, ticket, options) {
        calls.push({ name: "markDone", key: ticket.key, options });
        return { state: "done" };
      },
    },
    plane: {},
  };
}

export async function sequenceFixture(
  t,
  { pulls = [], repoSettings = {}, failures = {}, fetchImpl, getError } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-seq-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoPath = repo(root);
  const dataDir = path.join(root, "data");
  const forge = await fakeGithubPulls(t, { pulls, repo: repoSettings, failures });
  const clock = { now: T0 };
  const now = () => clock.now;
  const sourceCalls = [];
  const launched = [];
  const sent = [];
  const notified = [];
  const signals = [];
  const errors = [];
  const sessions = [];
  const queued = new Map();
  const runs = new Map();
  let count = 0;
  const hub = {
    invalidate: (name, param) =>
      signals.push(param === undefined ? name : `${name}:${param}`),
  };
  const launch = async (body, login, trusted) => {
    trusted.validateAccount?.({ id: body.accountId, tool: body.tool ?? "claude" });
    count += 1;
    const session = {
      id: `s${count}-${path.basename(body.cwd)}`,
      name: body.name,
      tool: body.tool ?? "claude",
      accountId: body.accountId ?? "a1",
      cwd: body.cwd,
      status: "running",
      createdAt: new Date(clock.now).toISOString(),
      ...(trusted.ticket ? { ticket: trusted.ticket } : {}),
    };
    sessions.push(session);
    launched.push({ body, login, trusted, session });
    return session;
  };
  const chatDelivery = {
    deliver: () => ({ status: "handed-off" }),
    async send(id, body) {
      sent.push({ id, ...body });
      return this.deliver(sent.length);
    },
  };
  const sessionsApi = {
    list: async () => structuredClone(sessions),
    get: async (id) => {
      const found = sessions.find((session) => session.id === id);
      if (!found) throw Object.assign(new Error("missing"), { status: 404 });
      return structuredClone(found);
    },
    stop: async (id) => {
      const found = sessions.find((session) => session.id === id);
      if (found) found.status = "stopped";
    },
  };
  const runQueue = {
    add(projectId, input, options) {
      if (queued.has(options.id)) throw Object.assign(new Error("dup"), { status: 409 });
      const item = { id: options.id, projectId, ...input, source: options.source };
      queued.set(options.id, { ...item, state: "queued" });
      return item;
    },
    find: (id) => queued.get(id) ?? null,
  };
  const pipelines = {
    get: async (id) => {
      const run = runs.get(id);
      if (!run) throw Object.assign(new Error("missing"), { status: 404 });
      return structuredClone(run);
    },
  };
  const ticketStore = new TicketStore({ dataDir });
  const tickets = new TicketService({
    store: ticketStore,
    memory: {
      project: (id) => {
        if (id === "p1") return { id, cwd: repoPath };
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
        fs.realpathSync(cwd) === fs.realpathSync(repoPath)
          ? "https://github.com/acme/app.git"
          : "",
    },
    launch,
    chatDelivery,
    sessions: sessionsApi,
    pipelines: { start: async () => ({ id: "manual-run" }) },
    live: () => hub,
    fetchImpl: fetchImpl ?? forge.fetchImpl,
    sources: fakeSources(sourceCalls, { getError }),
    now,
  });
  let store = new TicketSequenceStore({ dataDir, now });
  const worktrees = new TicketWorktrees({
    dataDir,
    github: {
      prepare: async () => ({ env: { ...process.env } }),
      discard: async () => {},
    },
  });
  // `restart: true` reads the queues again from disk, like a new server process.
  const build = ({ restart = false, ...extra } = {}) => {
    if (restart) store = new TicketSequenceStore({ dataDir, now });
    const built = new TicketSequenceEngine({
      store,
      tickets,
      worktrees,
      launch,
      chatDelivery,
      sessions: sessionsApi,
      runQueue,
      pipelines,
      notifications: { notify: async (event) => notified.push(event) },
      live: () => hub,
      now,
      intervalMs: 0,
      initialDelayMs: 0,
      onError: (error, step) => errors.push({ step, code: error?.code, error }),
      ...extra,
    });
    t.after(() => built.close());
    return built;
  };
  const engine = build();
  const append = (keys, { kind = "session", allowMerge = false, options = {} } = {}) =>
    store.append(
      "p1",
      repoPath,
      keys.map((key) => ({
        source: "github",
        key,
        title: `Fix thing ${key}`,
        url: `https://github.com/${key.replace("#", "/issues/")}`,
        kind,
        options: {
          allowMerge,
          ...(kind === "session"
            ? { session: { tool: "claude", accountId: "a1" } }
            : { pipeline: { pipelineId: "pl1" } }),
          ...options,
        },
      })),
    );
  const items = () => store.queue("p1")?.items ?? [];
  return {
    root,
    repoPath,
    dataDir,
    forge,
    clock,
    sourceCalls,
    launched,
    sent,
    notified,
    signals,
    errors,
    sessions,
    queued,
    runs,
    chatDelivery,
    ticketStore,
    tickets,
    get store() {
      return store;
    },
    engine,
    build,
    append,
    items,
    runQueue,
    pipelines,
    sessionsApi,
    worktrees,
  };
}

export const KEY = "acme/app#12";
export const GREEN = [
  {
    __typename: "CheckRun",
    name: "ci",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    isRequired: true,
  },
];
export const forgeMutations = (f, name) =>
  f.forge.calls.filter(
    (call) => call.method === "POST" && call.body?.query?.includes(`${name}(input`),
  );
export const forgeMerges = (f) => f.forge.calls.filter((call) => call.method === "PUT");

/** Starts the first ticket and opens its PR on the started branch. */
export async function awaitingMerge(f, { pull = {}, engine, ...options } = {}) {
  const runner = engine ?? f.engine;
  f.append([KEY, "acme/app#13"], options);
  await runner.run();
  const branch = f.items()[0].worktree.branch;
  const opened = githubPull(30, { headRef: branch, contexts: GREEN, ...pull });
  f.forge.pulls.push(opened);
  await runner.run();
  assert.equal(f.items()[0].state, "awaiting-merge");
  return opened;
}
