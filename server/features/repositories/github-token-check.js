// Checks one saved GitHub token against its host's REST API. Only paths built
// here receive the token; the result never contains it, only what GitHub reports
// about it (login, scopes, expiry, SAML SSO authorization).
export const expiringWithinMs = 7 * 24 * 60 * 60 * 1000;
const maxProbes = 5;
const component = /^[A-Za-z0-9_.-]{1,100}$/;

export function githubApiBase(host) {
  const url = new URL(host);
  if (url.hostname === "github.com") return "https://api.github.com";
  // GitHub Enterprise Cloud with data residency serves its API from api.<tenant>.
  if (url.hostname.endsWith(".ghe.com") && url.hostname.split(".").length === 3)
    return `https://api.${url.hostname}`;
  return `${url.origin}/api/v3`;
}

// Classified by the documented token prefixes; the prefix is no secret.
export function tokenType(token, headers) {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("gho_")) return "oauth";
  if (token.startsWith("ghu_") || token.startsWith("ghs_")) return "app";
  return headers?.has("x-oauth-scopes") ? "classic" : "unknown";
}

// GitHub reports e.g. "2026-11-01 12:00:00 UTC" (older releases: "+0000").
export function tokenExpiry(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)/, "$1T$2")
    .replace(/\s*UTC$/, "Z")
    .replace(/\s*([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// Owner and name of HTTPS project remotes on this credential's host.
export function remoteRepositories(host, urls) {
  const origin = new URL(host).origin;
  const seen = new Map();
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.origin !== origin) continue;
      const [owner, name] = url.pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "")
        .split("/");
      if (!component.test(owner || "") || !component.test(name || "")) continue;
      seen.set(`${owner}/${name}`.toLowerCase(), { owner, name });
    } catch {
      /* Not a URL remote. */
    }
  }
  return [...seen.values()].slice(0, maxProbes);
}

function ssoChallenge(header, host) {
  // "required; url=https://github.com/orgs/acme/sso?authorization_request=…"
  if (typeof header !== "string" || !/^\s*required\b/i.test(header)) return null;
  const match = /\burl=(\S+)/i.exec(header);
  let url = null;
  try {
    const candidate = match && new URL(match[1]);
    if (candidate && candidate.origin === new URL(host).origin) url = candidate.href;
  } catch {}
  return { url };
}

export async function checkGithubToken({
  host,
  token,
  repositories = [],
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 15000,
  signal,
}) {
  const checkedAt = new Date(now()).toISOString();
  const base = githubApiBase(host);
  const request = (pathname) =>
    fetchImpl(`${base}${pathname}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "AgentPier",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs),
    });
  let response;
  try {
    response = await request("/user");
  } catch {
    return { state: "error", error: "unreachable", checkedAt };
  }
  const headers = response.headers;
  const expiresAt = tokenExpiry(headers.get("github-authentication-token-expiration"));
  const type = tokenType(token, headers);
  const scopesHeader = headers.get("x-oauth-scopes");
  const scopes =
    scopesHeader === null
      ? null
      : scopesHeader
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean);
  const common = { checkedAt, tokenType: type, scopes, expiresAt };
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) {
      const expired = expiresAt && Date.parse(expiresAt) <= now();
      return {
        ...common,
        state: expired ? "expired" : "invalid",
        error: "unauthorized",
      };
    }
    const limited =
      response.status === 429 ||
      (response.status === 403 && headers.get("x-ratelimit-remaining") === "0");
    return {
      ...common,
      state: "error",
      error: limited
        ? "rateLimited"
        : response.status === 403
          ? "forbidden"
          : "unexpected",
    };
  }
  let login = null;
  try {
    const text = await response.text();
    const data = text.length <= 1024 * 1024 ? JSON.parse(text) : null;
    if (typeof data?.login === "string" && component.test(data.login)) login = data.login;
  } catch {}
  const sso = [];
  for (const { owner, name } of repositories) {
    try {
      const probe = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      );
      await probe.body?.cancel();
      const challenge =
        probe.status === 403 && ssoChallenge(probe.headers.get("x-github-sso"), host);
      if (challenge && !sso.some((item) => item.organization === owner))
        sso.push({
          organization: owner,
          ...(challenge.url ? { url: challenge.url } : {}),
        });
    } catch {
      /* A failed probe proves nothing about SSO. */
      if (signal?.aborted) break;
    }
  }
  const expiring = expiresAt && Date.parse(expiresAt) - now() <= expiringWithinMs;
  return {
    ...common,
    state: expiring ? "expiring" : "valid",
    login,
    sso,
  };
}
