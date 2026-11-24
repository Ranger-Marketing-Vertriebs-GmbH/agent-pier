import { gateItem } from "../inbox/inbox-items.js";
import { pullRequestByUrl, readPullRequest } from "../tickets/pr-forge.js";
import { prVerdict } from "../tickets/pr-status.js";
import { planeWebUrl } from "../tickets/sources/plane.js";
import { GITHUB_KEY, PLANE_KEY } from "../tickets/ticket-start-input.js";
import { TICKET_SOURCE_IDS } from "../tickets/ticket.js";

export const string = (value) => (typeof value === "string" && value ? value : null);
export const array = (value) => (Array.isArray(value) ? value : []);

export function sourceUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {}
  return null;
}

function ticketMatches(access, ticket) {
  if (!access || !ticket.url) return false;
  if (ticket.source === "github") {
    const parts = GITHUB_KEY.exec(ticket.key);
    if (!parts || !access.host) return false;
    const expected = sourceUrl(
      `${access.host}/${access.owner}/${access.repo}/issues/${parts[3]}`,
    );
    return (
      parts[1].toLowerCase() === access.owner.toLowerCase() &&
      parts[2].toLowerCase() === access.repo.toLowerCase() &&
      expected?.toLowerCase() === ticket.url.toLowerCase()
    );
  }
  if (
    ticket.source !== "plane" ||
    !PLANE_KEY.test(ticket.key) ||
    !ticket.key.startsWith(`${access.identifier}-`)
  )
    return false;
  return (
    ticket.url.replace(/\/$/, "") ===
    `${planeWebUrl(access.baseUrl)}/${access.workspaceSlug}/browse/${ticket.key}`
  );
}

/** Local records always come from the scoped project. Remote references identify a
 * ticket or PR at a configured access; the URL in the order is never fetched. */
export function orderSources(ref, services, { remote }) {
  const cache = new Map();
  let accessRead;
  let count = 0;
  let signal;
  function read(key, fn) {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  }
  async function accessFor(source) {
    if (!remote || !services.tickets?.accesses || !ref.projectRoot) return null;
    accessRead ??= Promise.resolve()
      .then(() => services.tickets.accesses({ id: ref.projectId, path: ref.projectRoot }))
      .catch(() => ({}));
    return (await accessRead)[source] ?? null;
  }
  // A large or stale local file must not fan out into unbounded authenticated reads.
  function remoteRead(fn) {
    signal ??= AbortSignal.timeout(6000);
    if (++count > 24 || signal.aborted) return null;
    return fn({ signal });
  }
  function run(id) {
    return read(`run:${id}`, () => {
      let record;
      try {
        record = services.pipelines?.store?.get(id);
      } catch {}
      const sameProject =
        record?.projectId === ref.projectId ||
        (record?.projectId === ref.projectRoot &&
          record.workspace?.projectRoot === ref.projectRoot);
      const unavailable = {
        id,
        status: null,
        link: null,
        resolution: "unavailable",
        gate: null,
        findings: [],
        pullRequestUrl: null,
        ticket: null,
      };
      if (!record || record.id !== id || !sameProject) return unavailable;
      const link = `/pipelines/runs/${encodeURIComponent(id)}`;
      const findings = array(record.nodes).flatMap((node) =>
        array(node?.verdict?.findings).map((finding) => ({
          title: string(finding?.title),
          severity: string(finding?.severity),
          detail: string(finding?.detail),
          criterion: string(finding?.criterion),
          url: link,
          runId: id,
          stage: node.id,
        })),
      );
      const gate =
        record.status === "awaiting-human" && !record.imported?.historyOnly
          ? gateItem(record)
          : null;
      return {
        id,
        link,
        resolution: "live",
        status: record.status,
        pipelineName: string(record.pipelineName),
        gate: gate && {
          kind: gate.kind,
          stage: gate.stage,
          title: gate.title,
          link: gate.link,
        },
        findings,
        pullRequestUrl: sourceUrl(record.pullRequestUrl),
        ticket: record.ticket && {
          source: string(record.ticket.source),
          key: string(record.ticket.key),
          title: string(record.ticket.title),
          url: sourceUrl(record.ticket.url),
        },
      };
    });
  }
  async function ticket(input) {
    const recorded = {
      source: string(input?.source ?? input?.system),
      key: string(input?.key ?? input?.identifier),
      id: string(input?.id),
      project: string(input?.project),
      instance: string(input?.instance),
      title: string(input?.title),
      url: sourceUrl(input?.url),
      status: string(input?.status ?? input?.state),
      resolution: "recorded",
    };
    if (!remote || !TICKET_SOURCE_IDS.includes(recorded.source)) return recorded;
    const access = await accessFor(recorded.source);
    if (!ticketMatches(access, recorded)) return recorded;
    const key = JSON.stringify(["ticket", recorded.source, recorded.key, recorded.url]);
    const live = await read(key, async () => {
      try {
        return await remoteRead((options) =>
          services.tickets.sources[recorded.source].get(access, recorded.key, options),
        );
      } catch {
        return null;
      }
    });
    if (!live || (recorded.id && String(live.id) !== recorded.id))
      return { ...recorded, resolution: "unavailable" };
    return {
      ...recorded,
      id: string(live.id),
      title: string(live.title),
      status: string(live.state),
      resolution: "live",
    };
  }
  async function pullRequest(input) {
    const url = sourceUrl(typeof input === "string" ? input : input?.url);
    if (!url) return null;
    const recorded = {
      url,
      source: string(input?.source),
      status: string(input?.status ?? input?.state),
      resolution: "recorded",
    };
    if (!remote || (recorded.source && recorded.source !== "github")) return recorded;
    const access = await accessFor("github");
    const match = access && pullRequestByUrl(access, url);
    if (!match) return recorded;
    const snapshot = await read(`pr:${match.number}`, async () => {
      try {
        return await remoteRead((options) =>
          readPullRequest(access, match.number, options),
        );
      } catch {
        return null;
      }
    });
    if (!snapshot) return { ...recorded, resolution: "unavailable" };
    const verdict = prVerdict(snapshot);
    return {
      ...recorded,
      source: "github",
      status: verdict.status,
      resolution: "live",
      checks: verdict.checks,
      reviewBlocks: verdict.reviewBlocks,
      inMergeQueue: snapshot.inMergeQueue,
      headSha: verdict.headSha,
    };
  }
  return { run, ticket, pullRequest };
}
