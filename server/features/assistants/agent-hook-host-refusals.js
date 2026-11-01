// A Host header as AgentPier may keep it: a host name or IPv4 address, or a bracketed
// IPv6 address, each with an optional port. Anything else is not kept at all.
const hostPattern = /^(?:[a-z0-9._~-]{1,253}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;

/** The received Host, lowercased, when it is a plain host; otherwise null. */
export function hookHostLabel(value) {
  if (typeof value !== "string") return null;
  const host = value.toLowerCase();
  return hostPattern.test(host) ? host : null;
}

/**
 * Hook requests the endpoint refused because their Host is none AgentPier accepts
 * (typically after a move, while Remote access still names the old machine): per
 * stored hook its few latest hosts with a count, kept in memory for a day. The
 * endpoint records only hooks that exist, so the map is bounded by the stored hooks
 * and an unknown ID leaves no trace. `record` says when an audit entry is due: the
 * first refusal of a hook and host, then at most once an hour.
 */
export class HookHostRefusals {
  constructor({
    now = Date.now,
    keepMs = 86_400_000,
    auditMs = 3_600_000,
    perHook = 3,
    listed = 10,
  } = {}) {
    Object.assign(this, { now, keepMs, auditMs, perHook, listed });
    this.hooks = new Map();
  }
  record(hookId, value) {
    const host = hookHostLabel(value);
    if (!host) return null;
    const now = this.now();
    const hosts = this.entries(hookId);
    const entry = hosts.get(host) || { count: 0, auditedAt: -Infinity };
    hosts.delete(host);
    const audit = now - entry.auditedAt >= this.auditMs;
    hosts.set(host, {
      count: entry.count + 1,
      at: now,
      auditedAt: audit ? now : entry.auditedAt,
    });
    // Insertion order is recency: the oldest host of the hook goes first.
    for (const old of hosts.keys()) {
      if (hosts.size <= this.perHook) break;
      hosts.delete(old);
    }
    this.hooks.set(hookId, hosts);
    return { audit };
  }
  /** The hook's entries of the last day, oldest first; expired ones are dropped. */
  entries(hookId) {
    const since = this.now() - this.keepMs;
    const hosts = this.hooks.get(hookId) || new Map();
    for (const [host, entry] of hosts) if (entry.at <= since) hosts.delete(host);
    if (!hosts.size) this.hooks.delete(hookId);
    return hosts;
  }
  /** The latest refused host of the hook, or null. */
  latest(hookId) {
    const last = [...this.entries(hookId)].at(-1);
    return last ? view(last) : null;
  }
  /** Refused hosts across all hooks, newest first, for Remote access. */
  recent() {
    const merged = new Map();
    for (const hookId of [...this.hooks.keys()])
      for (const [host, entry] of this.entries(hookId)) {
        const seen = merged.get(host);
        merged.set(host, {
          count: (seen?.count || 0) + entry.count,
          at: Math.max(seen?.at || 0, entry.at),
        });
      }
    return [...merged]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, this.listed)
      .map(view);
  }
  forget(hookId) {
    this.hooks.delete(hookId);
  }
}

const view = ([host, { count, at }]) => ({
  host,
  count,
  at: new Date(at).toISOString(),
});
