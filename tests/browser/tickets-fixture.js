import { hubFixture } from "./projects-fixture.js";

// The ticket routes of project m1 for the Tickets tab specs: the project view, the
// remote ticket list, single starts, the ticket sequence queue and the label rules.
export const connectedView = {
  project: { id: "m1", path: "/work/agent-pier" },
  sources: {
    github: {
      state: "connected",
      repo: "acme/app",
      host: "https://github.com",
      credential: { id: "c1", name: "Arbeit" },
      inProgressLabel: "in progress",
    },
    plane: {
      state: "connected",
      connectionId: "pc1",
      connectionName: "Plane Arbeit",
      planeProjectId: "11111111-1111-4111-8111-111111111111",
      identifier: "AP",
      name: "App",
      inProgressStateId: null,
    },
  },
  starts: [
    {
      id: "st1",
      projectId: "m1",
      source: "github",
      key: "acme/app#9",
      title: "Started issue",
      kind: "session",
      targetId: "s1",
      startedAt: 1000,
      writeBack: { state: "done" },
    },
    {
      id: "st2",
      projectId: "m1",
      source: "plane",
      key: "AP-4",
      title: "Refused item",
      kind: "pipeline",
      targetId: "r9",
      startedAt: 2000,
      writeBack: { state: "failed", code: "forbidden" },
    },
  ],
};

export const ticket = (source, key, title, labels) => ({
  source,
  key,
  number: Number(key.split(/[#-]/).at(-1)),
  id: key,
  title,
  body: "",
  url:
    source === "github"
      ? `https://github.com/acme/app/issues/${key.split("#")[1]}`
      : `https://plane.example/AP/${key}`,
  labels,
  state: "open",
  updatedAt: "2026-11-03T10:00:00Z",
});

export const ticketList = {
  tickets: [
    ticket("github", "acme/app#7", "Fix the login", ["ui"]),
    ticket("plane", "AP-3", "Add export", ["feature"]),
    ticket("github", "acme/app#9", "Started issue", ["bug"]),
    ticket("plane", "AP-4", "Refused item", ["bug"]),
  ],
  labels: ["bug", "feature", "ui"],
  errors: [],
};

export const emptyQueue = { queue: { items: [] }, defaults: { repair: null } };
export const noRules = { rules: [] };

// Answers the ticket routes of project m1; `list` (a value or a function) answers the
// remote ticket list and `start` each POST …/start. `queue`
// (a value or a function) answers GET …/queue; `queueAction({method, path, body})`
// answers the queue's writes (POST …/queue, …/retry, …/done, DELETE), which are
// recorded in `queueCalls` (with `query` when the URL has one); without it they answer the current queue.
// `rules` (a value or a function) answers GET …/rules, the `tickets.rules` topic's
// route; `ruleAction({method, path, body})` answers POST, PUT and DELETE …/rules, which
// are recorded in `ruleCalls`; without it they answer 201 `{ rule }`, 200 or 204.
export async function ticketsFixture(
  page,
  {
    view = connectedView,
    list = ticketList,
    start,
    queue = emptyQueue,
    queueAction,
    rules = noRules,
    ruleAction,
  },
) {
  const posts = [];
  const queueCalls = [];
  const ruleCalls = [];
  const currentQueue = () => (typeof queue === "function" ? queue() : queue);
  const currentRules = () => (typeof rules === "function" ? rules() : rules);
  const calls = await hubFixture(page, {
    intercept: async (route, url, method) => {
      // The launch dialog's own reads.
      if (url.pathname === "/api/ssh-accesses") {
        await route.fulfill({ json: { accesses: [] } });
        return true;
      }
      if (url.pathname === "/api/tickets/projects/m1") {
        await route.fulfill({ json: typeof view === "function" ? view() : view });
        return true;
      }
      if (url.pathname === "/api/tickets/projects/m1/tickets") {
        await route.fulfill({ json: typeof list === "function" ? list() : list });
        return true;
      }
      if (url.pathname === "/api/tickets/projects/m1/start" && method === "POST") {
        const body = route.request().postDataJSON();
        posts.push(body);
        const answer = start?.(body, posts.length) ?? {
          status: 201,
          json: { start: { id: "new" }, run: { id: "new-run" } },
        };
        await route.fulfill(answer);
        return true;
      }
      if (url.pathname.startsWith("/api/tickets/projects/m1/queue")) {
        if (method === "GET") {
          await route.fulfill({ json: currentQueue() });
          return true;
        }
        const call = {
          method,
          path: url.pathname.slice("/api".length),
          body: route.request().postDataJSON() ?? undefined,
          ...(url.search ? { query: url.search } : {}),
        };
        queueCalls.push(call);
        const answer = queueAction?.(call, queueCalls.length) ?? {
          status: method === "POST" && call.path.endsWith("/queue") ? 201 : 200,
          json: currentQueue(),
        };
        await route.fulfill(answer);
        return true;
      }
      if (url.pathname.startsWith("/api/tickets/projects/m1/rules")) {
        if (method === "GET") {
          await route.fulfill({ json: currentRules() });
          return true;
        }
        const call = {
          method,
          path: url.pathname.slice("/api".length),
          body: route.request().postDataJSON() ?? undefined,
        };
        ruleCalls.push(call);
        const answer =
          ruleAction?.(call, ruleCalls.length) ??
          (method === "DELETE"
            ? { status: 204, body: "" }
            : {
                status: method === "POST" ? 201 : 200,
                json: { rule: { id: "new", ...call.body } },
              });
        await route.fulfill(answer);
        return true;
      }
      return false;
    },
  });
  return { posts, calls, queueCalls, ruleCalls };
}
