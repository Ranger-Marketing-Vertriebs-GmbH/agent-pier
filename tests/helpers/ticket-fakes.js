import http from "node:http";

// Fake GitHub issues API on 127.0.0.1. `issues` are raw GitHub issue objects;
// `failures` maps "METHOD /path" (query ignored) to an HTTP status; `labels` (names)
// serves GET /repos/:o/:r/labels/:name case-insensitively.
export async function fakeGithub(t, { issues = [], failures = {}, labels = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method: req.method,
        path: req.url,
        body: raw ? JSON.parse(raw) : undefined,
        authorization: req.headers.authorization,
      });
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const failure = failures[`${req.method} ${url.pathname}`];
      if (failure) return send(failure, { message: "failure" });
      const list = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
      if (req.method === "GET" && list) {
        const label = url.searchParams.get("labels");
        const page = Number(url.searchParams.get("page") || 1);
        const size = Number(url.searchParams.get("per_page") || 30);
        const open = issues
          .filter((issue) => issue.state !== "closed")
          .filter((issue) => !label || issue.labels?.some((l) => l.name === label));
        return send(200, open.slice((page - 1) * size, page * size));
      }
      const label = /^\/repos\/[^/]+\/[^/]+\/labels\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && label) {
        const name = decodeURIComponent(label[1]);
        const found = labels.find((item) => item.toLowerCase() === name.toLowerCase());
        return found ? send(200, { name: found }) : send(404, { message: "Not Found" });
      }
      const one = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && one) {
        const issue = issues.find((item) => item.number === Number(one[3]));
        return issue ? send(200, issue) : send(404, { message: "Not Found" });
      }
      if (req.method === "PATCH" && one) {
        const issue = issues.find((item) => item.number === Number(one[3]));
        if (!issue) return send(404, { message: "Not Found" });
        Object.assign(issue, JSON.parse(raw || "{}"));
        return send(200, issue);
      }
      if (
        req.method === "DELETE" &&
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels\/[^/]+$/.test(url.pathname)
      )
        return send(200, []);
      if (req.method === "POST" && /\/issues\/\d+\/(labels|comments)$/.test(url.pathname))
        return send(200, []);
      send(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) =>
    fetch(String(url).replace("https://api.github.com", origin), init);
  return { origin, fetchImpl, calls };
}

export function githubIssue(number, extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/acme/app/issues/${number}`,
    state: "open",
    labels: [],
    updated_at: "2026-11-01T10:00:00Z",
    ...extra,
  };
}

// Fake Plane API on 127.0.0.1. Checks `X-API-Key` (token "plane-token"), paginates with
// `per_page`/`cursor` and expands state/labels when `expand` is requested. `failures` maps
// "METHOD /path" (query ignored) to an HTTP status. `ids: true` keeps ids even with expand.
export async function fakePlane(
  t,
  {
    projects = [],
    states = [],
    labels = [],
    items = [],
    failures = {},
    ids = false,
  } = {},
) {
  const calls = [];
  const paged = (url, rows) => {
    const size = Number(url.searchParams.get("per_page") || 20);
    const start = Number(url.searchParams.get("cursor") || 0);
    const next = start + size;
    return {
      results: rows.slice(start, next),
      next_cursor: String(next),
      next_page_results: next < rows.length,
      total_count: rows.length,
    };
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method: req.method,
        path: req.url,
        body: raw ? JSON.parse(raw) : undefined,
        apiKey: req.headers["x-api-key"],
      });
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.headers["x-api-key"] !== "plane-token") return send(401, {});
      const failure = failures[`${req.method} ${url.pathname}`];
      if (failure) return send(failure, { error: "failure" });
      const expand = (item) =>
        url.searchParams.has("expand") && !ids
          ? {
              ...item,
              state: states.find((s) => s.id === item.state) ?? item.state,
              labels: (item.labels ?? []).map(
                (id) => labels.find((l) => l.id === id) ?? id,
              ),
            }
          : item;
      const base = /^\/api\/v1\/workspaces\/([^/]+)\//.exec(url.pathname);
      if (!base) return send(404, {});
      const rest = url.pathname.slice(base[0].length);
      if (req.method === "GET" && rest === "projects/")
        return send(200, paged(url, projects));
      let match = /^projects\/([^/]+)\/(states|labels|work-items)\/$/.exec(rest);
      if (req.method === "GET" && match) {
        const rows = { states, labels, "work-items": items }[match[2]];
        const shown = match[2] === "work-items" ? rows.map(expand) : rows;
        return send(200, paged(url, shown));
      }
      match = /^work-items\/([A-Z0-9]+)-(\d+)\/$/.exec(rest);
      if (req.method === "GET" && match) {
        const item = items.find((i) => i.sequence_id === Number(match[2]));
        return item ? send(200, expand(item)) : send(404, {});
      }
      if (
        (req.method === "PATCH" && /^projects\/[^/]+\/work-items\/[^/]+\/$/.test(rest)) ||
        (req.method === "POST" &&
          /^projects\/[^/]+\/work-items\/[^/]+\/comments\/$/.test(rest))
      )
        return send(200, {});
      send(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls };
}

// A pull request for fakeGithubPulls. `contexts` are GraphQL check nodes
// (CheckRun: name/status/conclusion/isRequired; StatusContext: context/state/isRequired).
export function githubPull(number, extra = {}) {
  return {
    number,
    id: `PR_${number}`,
    headRef: `ticket/${number}-work`,
    headSha: String(number).padStart(40, "a"),
    headRepo: "acme/app",
    author: { login: "dev", type: "User" },
    baseRef: "main",
    state: "OPEN",
    createdAt: "2026-11-03T10:00:00Z",
    mergeable: "MERGEABLE",
    // null: derived from the checks and the review decision, like GitHub does.
    mergeStateStatus: null,
    reviewDecision: null,
    autoMerge: false,
    inMergeQueue: false,
    contexts: [],
    ...extra,
  };
}

// The merge states in which GitHub merges at once and refuses to arm auto-merge.
const MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

function checkDone(node) {
  if (node.__typename === "CheckRun")
    return node.status !== "COMPLETED"
      ? "pending"
      : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(node.conclusion)
        ? "success"
        : "failure";
  return node.state === "SUCCESS"
    ? "success"
    : node.state === "PENDING"
      ? "pending"
      : "failure";
}

/**
 * The PR's merge state: its own when set, else GitHub's rule of thumb: BLOCKED while a
 * required check is not green or a review is missing or requests changes, UNSTABLE when
 * only another check is not green, CLEAN otherwise.
 */
export function mergeState(pull) {
  if (pull.mergeStateStatus) return pull.mergeStateStatus;
  const contexts = pull.contexts ?? [];
  if (contexts.some((node) => node.isRequired && checkDone(node) !== "success"))
    return "BLOCKED";
  if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pull.reviewDecision))
    return "BLOCKED";
  if (contexts.some((node) => checkDone(node) !== "success")) return "UNSTABLE";
  return "CLEAN";
}

// Fake GitHub pull request API (REST + GraphQL) on 127.0.0.1 over an in-memory `pulls`
// array of githubPull objects. `repo` sets repository merge settings; `failures` maps
// "METHOD /path" to an HTTP status, or to a body sent with 200 (e.g. GraphQL errors);
// `graphqlErrors` are added to every GraphQL answer next to its data (partial errors).
// The pull list honours `head=<owner>:<branch>`.
// REST paths may carry the GHE prefix /api/v3; GraphQL answers on /graphql and /api/graphql.
export async function fakeGithubPulls(
  t,
  { pulls = [], repo = {}, failures = {}, graphqlErrors = null } = {},
) {
  const settings = {
    autoMergeAllowed: true,
    defaultMergeMethod: "SQUASH",
    defaultBranch: "main",
    mergeQueues: [],
    ...repo,
  };
  const calls = [];
  const restPull = (pull) => ({
    number: pull.number,
    html_url: `https://github.com/acme/app/pull/${pull.number}`,
    state: pull.state === "OPEN" ? "open" : "closed",
    created_at: pull.createdAt,
    user: pull.author,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      repo: pull.headRepo ? { full_name: pull.headRepo } : null,
    },
    base: { ref: pull.baseRef },
  });
  const graphPull = (pull) => ({
    id: pull.id,
    number: pull.number,
    url: `https://github.com/acme/app/pull/${pull.number}`,
    state: pull.state,
    headRefName: pull.headRef,
    headRefOid: pull.headSha,
    baseRefName: pull.baseRef,
    mergeable: pull.mergeable,
    mergeStateStatus: mergeState(pull),
    reviewDecision: pull.reviewDecision,
    isInMergeQueue: pull.inMergeQueue,
    autoMergeRequest: pull.autoMerge ? { enabledAt: "2026-11-03T10:05:00Z" } : null,
    commits: {
      nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: pull.contexts } } } }],
    },
  });
  const queue = (branch) =>
    settings.mergeQueues.includes(branch) ? { id: `MQ_${branch}` } : null;
  const graphql = ({ query, variables = {} }) => {
    const byId = (id) => pulls.find((pull) => pull.id === id);
    const mutation = /^\s*mutation/.test(query) ? /\{\s*(\w+)\(/.exec(query)?.[1] : null;
    if (mutation) {
      const input = variables.input ?? {};
      const pull = byId(input.pullRequestId ?? input.id);
      if (!pull) return { errors: [{ type: "NOT_FOUND", message: "no pull" }] };
      // GitHub refuses auto-merge on a PR that can merge right away.
      if (mutation === "enablePullRequestAutoMerge" && MERGEABLE.has(mergeState(pull)))
        return {
          errors: [{ type: "UNPROCESSABLE", message: "Pull request is in clean status" }],
        };
      if (mutation === "enablePullRequestAutoMerge") pull.autoMerge = true;
      else if (mutation === "disablePullRequestAutoMerge") pull.autoMerge = false;
      else if (mutation === "enqueuePullRequest") pull.inMergeQueue = true;
      else if (mutation === "dequeuePullRequest") pull.inMergeQueue = false;
      else return { errors: [{ message: "unknown mutation" }] };
      return { data: { [mutation]: { clientMutationId: null } } };
    }
    if (query.includes("pullRequest(number")) {
      const pull = pulls.find((item) => item.number === variables.n);
      return {
        data: {
          repository: {
            autoMergeAllowed: settings.autoMergeAllowed,
            viewerDefaultMergeMethod: settings.defaultMergeMethod,
            defaultBranchRef: { name: settings.defaultBranch },
            mergeQueue: queue(settings.defaultBranch),
            pullRequest: pull ? graphPull(pull) : null,
          },
        },
      };
    }
    if (query.includes("mergeQueue(branch"))
      return { data: { repository: { mergeQueue: queue(variables.branch) } } };
    return { errors: [{ message: "unknown query" }] };
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname.replace(/^\/api\/v3(?=\/)/, "");
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({
        method: req.method,
        path: req.url,
        body,
        authorization: req.headers.authorization,
      });
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const failure = failures[`${req.method} ${url.pathname}`];
      if (typeof failure === "number") return send(failure, { message: "failure" });
      if (failure) return send(200, failure);
      if (req.method === "POST" && (path === "/graphql" || path === "/api/graphql")) {
        const answer = graphql(body ?? {});
        if (graphqlErrors) answer.errors = [...(answer.errors ?? []), ...graphqlErrors];
        return send(200, answer);
      }
      if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path))
        return send(200, { default_branch: settings.defaultBranch });
      if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
        const size = Number(url.searchParams.get("per_page") || 30);
        const head = url.searchParams.get("head");
        const sorted = [...pulls]
          .filter(
            (pull) => !head || `${pull.headRepo?.split("/")[0]}:${pull.headRef}` === head,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return send(200, sorted.slice(0, size).map(restPull));
      }
      const merge = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/.exec(path);
      if (req.method === "PUT" && merge) {
        const pull = pulls.find((item) => item.number === Number(merge[1]));
        if (!pull) return send(404, { message: "Not Found" });
        if (pull.state !== "OPEN" || !MERGEABLE.has(mergeState(pull)))
          return send(405, { message: "not mergeable" });
        if (body?.sha !== pull.headSha) return send(409, { message: "head moved" });
        pull.state = "MERGED";
        return send(200, { merged: true, sha: "f".repeat(40) });
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) =>
    fetch(
      String(url)
        .replace("https://api.github.com", origin)
        .replace("https://ghe.example", origin),
      init,
    );
  return { origin, fetchImpl, calls, pulls };
}
