import { githubApiBase } from "../../repositories/github-token-check.js";
import { cleanTicket } from "../ticket.js";
import { requestJson, TicketSourceError } from "../http-json.js";

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

function valid(owner, repo) {
  return NAME.test(owner) && NAME.test(repo);
}

export function parseGithubRemote(remote) {
  const value = String(remote ?? "").trim();
  let host;
  let rest;
  const scp = /^[A-Za-z0-9_.-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(value);
  if (scp) {
    host = scp[1];
    rest = scp[2];
  } else {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname) return null;
    host = url.host;
    if (url.protocol === "ssh:") host = url.hostname;
    rest = url.pathname.replace(/^\//, "");
  }
  const parts = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2 || !valid(parts[0], parts[1])) return null;
  return { host: `https://${host.toLowerCase()}`, owner: parts[0], repo: parts[1] };
}

export function resolveGithubApiBase(host) {
  return githubApiBase(host);
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function toTicket(access, issue) {
  return cleanTicket({
    source: "github",
    key: `${access.owner}/${access.repo}#${issue.number}`,
    number: issue.number,
    id: String(issue.number),
    title: issue.title,
    body: issue.body,
    url: issue.html_url,
    labels: (Array.isArray(issue.labels) ? issue.labels : []).map((label) =>
      typeof label === "string" ? label : label?.name,
    ),
    state: issue.state === "closed" ? "closed" : "open",
    updatedAt: issue.updated_at,
  });
}

function call(access, path, options = {}) {
  return requestJson({
    fetchImpl: access.fetchImpl,
    url: `${access.apiBase}${path}`,
    headers: headers(access.token),
    ...options,
  });
}

function repoPath(access) {
  return `/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

export const githubSource = {
  id: "github",
  async list(access, { label, signal } = {}) {
    const tickets = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = `state=open&per_page=${PAGE_SIZE}&page=${page}${
        label ? `&labels=${encodeURIComponent(label)}` : ""
      }`;
      const { data } = await call(access, `${repoPath(access)}/issues?${query}`, {
        signal,
      });
      if (!Array.isArray(data)) throw new TicketSourceError("invalidResponse");
      for (const issue of data) {
        if (issue && !issue.pull_request && Number.isInteger(issue.number))
          tickets.push(toTicket(access, issue));
      }
      if (data.length < PAGE_SIZE) break;
    }
    const names = new Set(tickets.flatMap((ticket) => ticket.labels));
    const labels = [...names].sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "base" }),
    );
    return { tickets, labels };
  },
  async get(access, key, { signal } = {}) {
    const match = /^([^/#]+)\/([^/#]+)#([1-9]\d{0,8})$/.exec(String(key ?? ""));
    if (
      !match ||
      match[1].toLowerCase() !== access.owner.toLowerCase() ||
      match[2].toLowerCase() !== access.repo.toLowerCase()
    )
      throw new TicketSourceError("notFound");
    const { data } = await call(access, `${repoPath(access)}/issues/${match[3]}`, {
      signal,
    });
    if (!data || typeof data !== "object" || data.pull_request)
      throw new TicketSourceError("notFound");
    return toTicket(access, data);
  },
  async markInProgress(access, ticket, { link, kind, label, signal } = {}) {
    const base = `${repoPath(access)}/issues/${encodeURIComponent(ticket.number)}`;
    await call(access, `${base}/labels`, {
      method: "POST",
      body: { labels: [label] },
      signal,
    });
    const noun = kind === "session" ? "session" : "pipeline run";
    await call(access, `${base}/comments`, {
      method: "POST",
      body: { body: `Started in AgentPier: [${noun}](${link})` },
      signal,
    });
    return { state: "done" };
  },
};
