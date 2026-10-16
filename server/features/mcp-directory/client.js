import { download as fetchDownload } from "../operations/releases.js";
import {
  detailKey,
  healthKey,
  normaliseSearch,
  searchKey,
  ttl,
  TtlCache,
} from "./cache.js";
import { directoryProblem } from "./directory-errors.js";
import { isLoopbackHost } from "./directory-settings.js";
import { cursorOf, isServerName, normaliseDetail, normaliseList } from "./normalise.js";

// The MCP Registry, asked on demand only (decision Q1): an owner search, an opened
// detail, the Source card's health check or the MCP list's update check.
export const listLimit = 2 * 1024 * 1024;
export const detailLimit = 512 * 1024;
const healthLimit = 64 * 1024;
const negative = (status) => status === 429 || (status >= 500 && status <= 599);

/** A loopback http registry (tests, local subregistries): no redirects, size-capped. */
async function loopbackDownload(url, fetchImpl, limit, headers) {
  const response = await fetchImpl(url, { redirect: "manual", headers });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Object.assign(new Error("redirect"), { status: 502 });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("status"), { status: response.status });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export class McpDirectory {
  constructor({
    settings,
    fetchImpl = fetch,
    now = Date.now,
    log = console.error,
    deadlineMs = 10000,
  }) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.deadlineMs = deadlineMs;
    this.cache = new TtlCache({ now });
    this.generation = 0;
  }
  /** Empties the cache; answers still in flight from before are not stored. */
  clear() {
    this.generation += 1;
    this.cache.clear();
  }
  current() {
    const settings = this.settings();
    return { ...settings, host: new URL(settings.baseUrl).host };
  }
  enabled() {
    const settings = this.current();
    if (!settings.enabled) throw directoryProblem("MCP_DIRECTORY_DISABLED");
    return settings;
  }
  /**
   * Bytes of `url`, with origin pinning, a size cap and one overall deadline. A
   * failure carries `upstream`: the registry's last HTTP status (0 without one).
   */
  async fetchBytes(url, limit) {
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const seen = { status: 0 };
    const fetchImpl = async (target, init = {}) => {
      const response = await this.fetchImpl(target, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
      seen.status = response.status;
      return response;
    };
    const headers = { accept: "application/json" };
    const parsed = new URL(url);
    try {
      if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
        return await loopbackDownload(url, fetchImpl, limit, headers);
      return await fetchDownload(url, fetchImpl, limit, {
        headers,
        pinOrigin: true,
        retries: 0,
      });
    } catch (error) {
      throw Object.assign(new Error("MCP directory download failed", { cause: error }), {
        upstream: seen.status,
      });
    }
  }
  /** JSON from the registry, cached; failures map to stable directory codes. */
  async request({ key, url, limit, lifetime, host, lookup = false }) {
    const cached = this.cache.get(key);
    if (cached?.error) throw directoryProblem(cached.error);
    if (cached) return cached.body;
    const generation = this.generation;
    const remember = (value, lifetime) => {
      if (generation === this.generation) this.cache.set(key, value, lifetime);
    };
    let bytes;
    try {
      bytes = await this.fetchBytes(url, limit);
    } catch (failure) {
      const upstream = failure?.upstream ?? 0;
      // A 404 is "not found" only for a detail lookup; on a list or health URL it
      // means the base URL is not a registry.
      const code =
        upstream === 404
          ? lookup
            ? "MCP_DIRECTORY_NOT_FOUND"
            : "MCP_DIRECTORY_MISCONFIGURED"
          : "MCP_DIRECTORY_UNAVAILABLE";
      // 429 and 5xx: the registry asked for a pause; do not ask again for 60 s.
      if (negative(upstream)) remember({ error: code }, ttl.negative);
      // Code and host only: never the search term or the address.
      this.log(`AgentPier MCP directory request failed (${code}, ${host}).`);
      throw directoryProblem(code);
    }
    let body;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      this.log(
        `AgentPier MCP directory request failed (MCP_DIRECTORY_UNAVAILABLE, ${host}).`,
      );
      throw directoryProblem("MCP_DIRECTORY_UNAVAILABLE");
    }
    remember({ body }, lifetime);
    return body;
  }
  async search({ search = "", cursor = "" } = {}) {
    const { baseUrl, host } = this.enabled();
    if (cursor && !cursorOf(cursor))
      throw directoryProblem("MCP_DIRECTORY_INVALID_REQUEST");
    const query = new URLSearchParams({
      search: normaliseSearch(search),
      limit: "30",
      version: "latest",
    });
    if (cursor) query.set("cursor", cursor);
    const body = await this.request({
      key: searchKey(baseUrl, search, cursor),
      url: `${baseUrl}/v0.1/servers?${query}`,
      limit: listLimit,
      lifetime: ttl.success,
      host,
    });
    return normaliseList(body);
  }
  async detail(name) {
    const { baseUrl, host } = this.enabled();
    if (!isServerName(name)) throw directoryProblem("MCP_DIRECTORY_INVALID_REQUEST");
    const body = await this.request({
      key: detailKey(baseUrl, name),
      url: `${baseUrl}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`,
      limit: detailLimit,
      lifetime: ttl.success,
      host,
      lookup: true,
    });
    try {
      return normaliseDetail(body);
    } catch (error) {
      throw directoryProblem(
        error.code === "MCP_DIRECTORY_NOT_FOUND" ? error.code : "MCP_DIRECTORY_INVALID",
      );
    }
  }
  async status() {
    const { enabled, baseUrl, host } = this.current();
    if (!enabled) return { enabled, host, reachable: false };
    try {
      await this.request({
        key: healthKey(baseUrl),
        url: `${baseUrl}/v0.1/health`,
        limit: healthLimit,
        lifetime: ttl.health,
        host,
      });
      return { enabled, host, reachable: true };
    } catch {
      return { enabled, host, reachable: false };
    }
  }
}
