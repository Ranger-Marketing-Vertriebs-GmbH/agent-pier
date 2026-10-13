// The model IDs a ChatGPT account can pin: resolve() turns one into
// `openai/<modelId>@<profileId>`, so only bare IDs survive.
export const accountModelId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
// A listed catalog stays current for ten minutes; a failed read is retried after one.
export const catalogTtlMs = 10 * 60_000;
export const catalogRetryMs = 60_000;
const maxModels = 500;

/**
 * The Gateway's `models.list` answer for the `openai` provider, reduced to what
 * the agent editor shows. `null` marks an answer this version does not understand.
 * A row the Gateway marks unavailable is dropped unless only a cooldown blocks it.
 */
export function parseModelsList(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.models)) return null;
  const seen = new Set();
  const models = [];
  for (const row of result.models) {
    if (!row || typeof row !== "object" || row.provider !== "openai") continue;
    const modelId = row.id;
    if (typeof modelId !== "string" || !accountModelId.test(modelId)) continue;
    if (row.available === false && row.unavailableReason !== "cooldown") continue;
    if (seen.has(modelId) || models.length >= maxModels) continue;
    seen.add(modelId);
    const label =
      typeof row.name === "string" && row.name.trim()
        ? row.name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200)
        : modelId;
    models.push({ modelId, label });
  }
  const outcomes = new Map(
    (Array.isArray(result.providerOutcomes) ? result.providerOutcomes : [])
      .filter((o) => o?.provider === "openai" && typeof o.profileId === "string")
      .map((o) => [o.profileId, o.status]),
  );
  const pending =
    Array.isArray(result.pendingProviders) && result.pendingProviders.includes("openai");
  return { models, outcomes, pending };
}

/**
 * The models each signed-in ChatGPT account can select, read from the running
 * Gateway. One `models.list` read serves every account, because the accounts
 * share the native `main` agent; the Gateway's per-profile outcome decides
 * whether an account gets the list. Reads run in the background, at most one at
 * a time, and a listed catalog stays current for `ttlMs`.
 */
export class ModelAccountCatalog {
  #inflight = null;
  #result = null;
  #failed = false;
  #attemptedAt = -Infinity;
  constructor({
    runtime,
    now = Date.now,
    ttlMs = catalogTtlMs,
    retryMs = catalogRetryMs,
    onChange = () => {},
  }) {
    Object.assign(this, { runtime, now, ttlMs, retryMs, onChange });
  }
  /** The read in progress, if any. */
  get loading() {
    return this.#inflight;
  }
  /** What the editor shows for one account; never waits for the Gateway. */
  account(profileId) {
    const ready = !!this.runtime.client?.ready;
    const outcome = this.#result?.outcomes.get(profileId);
    const rejected = outcome !== undefined && outcome !== "ready";
    const models = rejected ? [] : this.#result?.models || [];
    const modelCatalog = this.#inflight
      ? "loading"
      : !ready || this.#failed || rejected
        ? "failed"
        : this.#result
          ? "ready"
          : "loading";
    return { models, modelCatalog };
  }
  stale() {
    const age = this.now() - this.#attemptedAt;
    return age >= (this.#failed || !this.#result ? this.retryMs : this.ttlMs);
  }
  /** Starts a background read when the cached catalog is stale. */
  ensure() {
    if (this.#inflight || !this.runtime.client?.ready || !this.stale()) return;
    this.refresh().catch(() => {});
  }
  /**
   * Reads the catalog now. `force` asks the Gateway to rediscover provider models,
   * for example after a sign-in. A read already running is shared, not repeated.
   */
  refresh({ force = false } = {}) {
    if (this.#inflight) return this.#inflight;
    const client = this.runtime.client;
    if (!client?.ready) return Promise.reject(Object.assign(Error(), { status: 503 }));
    this.#attemptedAt = this.now();
    const read = (refresh) =>
      client.call(
        "models.list",
        {
          agentId: "main",
          provider: "openai",
          view: "all",
          ...(refresh ? { refresh } : {}),
        },
        { timeoutMs: 60000 },
      );
    const job = (async () => {
      try {
        let parsed = parseModelsList(await read(force));
        // A first read can come before discovery; a refresh waits for it.
        if (parsed?.pending && !force) parsed = parseModelsList(await read(true));
        if (!parsed || parsed.pending) throw Error("Unexpected models.list result");
        this.#result = parsed;
        this.#failed = false;
      } catch (error) {
        this.#failed = true;
        throw error;
      } finally {
        this.#attemptedAt = this.now();
        this.#inflight = null;
        this.onChange();
      }
    })();
    this.#inflight = job;
    return job;
  }
}
