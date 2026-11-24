import path from "node:path";
import { requestItem } from "../inbox/inbox-items.js";
import { array, orderSources, sourceUrl, string } from "./order-sources.js";

const record = (item) => item && typeof item === "object" && !Array.isArray(item);
const done = new Set(["completed", "done", "merged"]);
const waiting = new Set(["waiting", "awaiting-human", "needs-owner", "blocked"]);
const active = new Set(["active", "running", "implementing", "monitoring"]);
const ticketKey = (t) => JSON.stringify([t.source, t.key, t.url, t.id]);
const unique = (items, key) => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

function distinctPullRequests(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    const previous = byUrl.get(entry.url);
    if (!previous || entry.resolution === "live" || (!previous.status && entry.status))
      byUrl.set(entry.url, entry);
  }
  return [...byUrl.values()];
}

function counts(entries) {
  const byStatus = new Map();
  for (const entry of entries) {
    const status = entry.status || "unknown";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  return { total: entries.length, byStatus: Object.fromEntries(byStatus) };
}

function findingView(value) {
  return {
    title: string(value?.title ?? value),
    detail: string(value?.detail ?? value?.evidence),
    severity: string(value?.severity),
    url: sourceUrl(value?.url ?? value?.sourceUrl),
  };
}

/** Project, resource links and cleanup evidence come from the private register.
 * The Composer snapshot describes the work, including work recorded before orders
 * had stable item IDs. An anonymous old item stays anonymous across reads. */
export async function orderView(
  { ref, document, limitations = [], session = null },
  services,
  { remote = false } = {},
) {
  const doc = record(document) ? document : {};
  const limits = new Set(limitations);
  const sources = orderSources(ref, services, { remote });
  // A CLI can disappear after AgentPier accepts a start and before it checkpoints
  // the returned run ID. Only this order's private MCP receipts fill that gap.
  const receipts = ref.managed
    ? (services.mcpTools?.requests.forOrder(ref.id, ref.projectId) ?? [])
    : [];
  const byRequest = new Map();
  const startReceipts = receipts.map(({ requestId, runId }) => {
    const queue = services.pipelineQueue?.find(runId);
    const queueState = queue?.projectId === ref.projectId ? queue.state : null;
    const confirmed = sources.run(runId).resolution === "live";
    if (confirmed) byRequest.set(requestId, runId);
    else if (!queueState) limits.add("unconfirmedStart");
    return { requestId, runId, confirmed, queueState };
  });
  const all = { runs: [], tickets: [], pullRequests: [], findings: [] };
  async function links(entry) {
    const ticketRefs = [...array(entry.tickets), entry.ticket].filter(record);
    // Early skill files kept the run and PR directly on the ticket or batch.
    const owners = [entry, ...ticketRefs];
    const ids = owners
      .flatMap((owner) => [
        owner.runId,
        byRequest.get(owner.requestId),
        ...array(owner.runIds),
        ...array(owner.runs).map((r) => r?.id ?? r?.runId ?? r),
      ])
      .map(string)
      .filter(Boolean);
    const runs = [...new Set(ids)].map(sources.run);
    const tickets = [];
    for (const t of [...ticketRefs, ...runs.map((r) => r.ticket).filter(Boolean)])
      tickets.push(await sources.ticket(t));
    const prs = owners.flatMap((owner) => [
      owner.pr,
      owner.prUrl,
      ...array(owner.pullRequests),
    ]);
    const pullRequests = [];
    for (const pr of [...prs, ...runs.map((r) => r.pullRequestUrl)].filter(Boolean)) {
      const reconciled = await sources.pullRequest(pr);
      if (reconciled) pullRequests.push(reconciled);
    }
    const findings = [
      ...array(entry.findings)
        .map(findingView)
        .filter((f) => f.title),
      ...runs.flatMap((r) => r.findings),
    ];
    all.runs.push(...runs);
    all.tickets.push(...tickets);
    all.pullRequests.push(...pullRequests);
    all.findings.push(...findings);
    return {
      runs,
      tickets: unique(tickets, ticketKey),
      pullRequests: distinctPullRequests(pullRequests),
      findings,
    };
  }

  async function item(value) {
    const entry = record(value) ? value : {};
    const id = string(entry.id);
    if (!id) limits.add("missingItemId");
    return {
      id,
      title: string(entry.title ?? value),
      task: string(entry.task ?? entry.brief),
      dependsOn: array(entry.dependsOn).map(string).filter(Boolean),
      status: string(entry.status),
      checkpoint: string(entry.checkpoint),
      nextAction: string(entry.nextAction),
      ...(await links(entry)),
    };
  }
  async function batches(values) {
    const result = [];
    for (const value of array(values)) {
      const batch = await item(value);
      const items = [];
      for (const entry of array(value?.items)) items.push(await item(entry));
      result.push({ ...batch, items, counts: counts(items) });
    }
    return result;
  }

  await links(doc);
  await links({ runIds: [...byRequest.values()] });
  const unassigned = [];
  for (const value of array(doc.items)) unassigned.push(await item(value));
  const topics = await batches(doc.topics);
  const approved = await batches(doc.batches);
  const draft = await batches(doc.draftBatches);
  const runs = unique(all.runs, (r) => r.id);
  const tickets = unique(all.tickets, ticketKey);
  const pullRequests = distinctPullRequests(all.pullRequests);
  const findings = unique(all.findings, (f) => JSON.stringify(f));
  if (runs.some((r) => r.resolution === "unavailable")) limits.add("runUnavailable");
  if (!session) limits.add("sessionUnmapped");
  const workspace = ref.managed && ref.resources?.workspace;
  if (!workspace) limits.add("worktreeUnmapped");
  const requests =
    session?.status === "running"
      ? (services.requests?.listAll() ?? [])
          .filter((entry) => entry.sessionId === session.id)
          .map((entry) => requestItem(entry, session))
          .map(({ id, kind, title, link }) => ({ id, kind, title, link }))
      : [];
  if (!ref.managed) limits.add("ownershipUnverified");
  const reportedStatus = string(doc.status);
  const manualPaused = doc.manualPaused === true;
  const status = manualPaused ? "paused" : reportedStatus;
  const openRuns = runs.some((r) => ["running", "awaiting-human"].includes(r.status));
  const openPR = pullRequests.some((p) =>
    ["open", "closed"].includes(p.status?.toLowerCase()),
  );
  const openBatch = approved.some(
    (b) =>
      (b.status && !done.has(b.status)) ||
      b.items.some((i) => i.status && !done.has(i.status)),
  );
  const queued = startReceipts.some((receipt) =>
    ["queued", "starting"].includes(receipt.queueState),
  );
  const hasOpenWork = openRuns || openPR || openBatch || queued;
  let state = "unknown";
  if (status === "paused") state = "paused";
  else if (requests.length || runs.some((r) => r.gate) || waiting.has(status))
    state = "waiting";
  else if (active.has(status) || openRuns) state = "active";
  else if (done.has(status) && !hasOpenWork) state = "completed";
  else if (["draft", "planned", "planning"].includes(status)) state = "draft";
  return {
    id: ref.id,
    projectId: ref.projectId,
    managed: ref.managed === true,
    title:
      string(doc.title) ||
      string(doc.topic) ||
      (ref.filename && path.basename(ref.filename, ".json")) ||
      ref.id,
    brief: string(doc.brief ?? doc.scope ?? doc.task),
    filename: string(ref.filename),
    sourceId: string(doc.id),
    projectName: ref.projectRoot ? path.basename(ref.projectRoot) : null,
    projectRoot: ref.projectRoot,
    worktree: workspace?.cwd ?? null,
    branch: workspace?.branch ?? null,
    cleanup: Boolean(ref.cleanup),
    requests,
    selection:
      ref.managed && ref.selection
        ? Object.fromEntries(
            [
              "tool",
              "accountId",
              "providerConnectionId",
              "providerModelId",
              "nativeModelId",
              "launchMode",
            ]
              .filter((key) => typeof ref.selection[key] === "string")
              .map((key) => [key, ref.selection[key]]),
          )
        : null,
    allowMerge: doc.allowMerge === true,
    implementationAuthorized: doc.implementationAuthorized === true,
    planStatus: string(doc.planStatus),
    status,
    state,
    reportedStatus,
    manualPaused,
    checkpoint: string(doc.checkpoint),
    nextAction: string(doc.nextAction),
    lastCheckedAt: string(doc.lastCheckedAt),
    nextCheckAt: string(doc.nextCheckAt),
    session: session && {
      id: session.id,
      status: session.status,
      link: `/sessions/${encodeURIComponent(session.id)}/chat`,
    },
    draftBatches: draft,
    batches: approved,
    items: unassigned,
    topics,
    runs,
    tickets,
    pullRequests,
    findings,
    hasOpenWork,
    startReceipts,
    counts: {
      batches: counts(approved),
      items: counts(approved.flatMap((b) => b.items)),
      tickets: counts(tickets),
      runs: counts(runs),
    },
    limitations: [...limits],
  };
}
