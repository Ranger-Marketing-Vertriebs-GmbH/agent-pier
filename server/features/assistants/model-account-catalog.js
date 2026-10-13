// The model IDs a ChatGPT account can pin: resolve() turns one into
// `openai/<modelId>@<profileId>`, so only bare IDs survive.
export const accountModelId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
// A listed catalog stays current for ten minutes; a failed read is retried after one.
export const catalogTtlMs = 10 * 60_000;
export const catalogRetryMs = 60_000;
const maxModels = 500;
// A refresh answers after at most five seconds (OpenClaw's foreground wait), with
// openai still pending when discovery takes longer; the next refresh joins that
// discovery instead of starting another. One read of the catalog, including these
// refreshes, ends within two minutes, a single Gateway call within one; the count
// bounds a Gateway that would answer "pending" without waiting.
const readBudgetMs = 120_000;
const callTimeoutMs = 60_000;
const pendingReads = 24;

/**
 * The Gateway's `models.list` answer for the `openai` provider, reduced to what
 * the agent editor shows. `null` marks an answer this version does not understand.
 * Only rows the Gateway marks available survive, and those blocked by a cooldown
 * alone; without `includeDetails` every row carries a boolean, so a row without
 * one is dropped (fail closed).
 */
export function parseModelsList(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.models)) return null;
  const seen = new Set();
  const models = [];
  for (const row of result.models) {
    if (!row || typeof row !== "object" || row.provider !== "openai") continue;
    const modelId = row.id;
    if (typeof modelId !== "string" || !accountModelId.test(modelId)) continue;
    if (row.available !== true && row.unavailableReason !== "cooldown") continue;
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
  // `refreshFailed` covers every provider of the catalog; the list is stale only
  // when the openai discovery itself was unavailable.
  const stale =
    result.refreshFailed === true &&
    (Array.isArray(result.providerOutcomes) ? result.providerOutcomes : []).some(
      (o) => o?.provider === "openai" && o.status === "unavailable",
    );
  return { models, outcomes, pending, stale };
}

/** A Gateway error code for the log; never the Gateway's message text. */
const errorCode = (error) =>
  /^[A-Z_]{1,60}$/.test(error?.code) ? error.code : "unexpected answer";

/**
 * The ChatGPT models of the native `main` agent, read from the running Gateway.
 * The accounts share that agent, so one `models.list` read serves all of them:
 * discovery and row availability follow the profile the Gateway selects, not each
 * account. A profile's own outcome, when the Gateway reports one, still withholds
 * the list from a rejected account. Reads run in the background, one at a time; a
 * forced read asked for during an unforced one runs right after it.
 */
export class ModelAccountCatalog {
  #inflight = null;
  #forced = false;
  #queued = null;
  #result = null;
  #failed = false;
  #attemptedAt = -Infinity;
  constructor({
    runtime,
    now = Date.now,
    ttlMs = catalogTtlMs,
    retryMs = catalogRetryMs,
    onChange = () => {},
    warn = console.warn,
  }) {
    Object.assign(this, { runtime, now, ttlMs, retryMs, onChange, warn });
  }
  /** The read in progress or queued, if any. */
  get loading() {
    return this.#queued || this.#inflight;
  }
  /**
   * What the editor shows for one of `accounts` signed-in accounts; never waits.
   * `unknown`: the Gateway checked the list against another account.
   */
  account(profileId, { accounts = 1 } = {}) {
    if (this.#inflight || this.#queued)
      return { models: this.#models(profileId), modelCatalog: "loading" };
    const outcome = this.#result?.outcomes.get(profileId);
    const models = this.#models(profileId);
    const modelCatalog =
      !this.runtime.client?.ready ||
      this.#failed ||
      this.#result?.stale ||
      (outcome !== undefined && outcome !== "ready") ||
      (this.#result && !models.length)
        ? "failed"
        : !this.#result
          ? // Nothing read yet and no read running: the page's next load starts one.
            "failed"
          : outcome === undefined && accounts > 1
            ? "unknown"
            : "ready";
    return { models, modelCatalog };
  }
  #models(profileId) {
    const outcome = this.#result?.outcomes.get(profileId);
    return outcome !== undefined && outcome !== "ready" ? [] : this.#result?.models || [];
  }
  stale() {
    const age = this.now() - this.#attemptedAt;
    const failed = this.#failed || !this.#result || this.#result.stale;
    return age >= (failed ? this.retryMs : this.ttlMs);
  }
  /**
   * Starts a background read when the cached catalog is stale. After a stale
   * openai discovery only a forced read can replace the Gateway's catalog.
   */
  ensure() {
    if (this.loading || !this.runtime.client?.ready || !this.stale()) return;
    this.refresh({ force: !!this.#result?.stale }).catch(() => {});
  }
  /**
   * Reads the catalog now. `force` asks the Gateway to rediscover provider models,
   * for example after a sign-in. A read already running is shared; a forced one
   * asked for during an unforced read is chained after it, once.
   */
  refresh({ force = false } = {}) {
    if (this.#inflight && (!force || this.#forced)) return this.#inflight;
    if (this.#inflight)
      return (this.#queued ??= this.#inflight
        .catch(() => {})
        .then(() => {
          this.#queued = null;
          return this.refresh({ force: true });
        }));
    const client = this.runtime.client;
    if (!client?.ready) return Promise.reject(Object.assign(Error(), { status: 503 }));
    const deadline = Date.now() + readBudgetMs;
    const read = (refresh) =>
      client.call(
        "models.list",
        {
          agentId: "main",
          provider: "openai",
          view: "all",
          ...(refresh ? { refresh } : {}),
        },
        { timeoutMs: Math.max(1, Math.min(callTimeoutMs, deadline - Date.now())) },
      );
    this.#forced = force;
    this.#inflight = (async () => {
      try {
        let parsed = parseModelsList(await read(force));
        // A first read can come before discovery; a refresh waits for it, and slow
        // discovery outlasts a refresh's wait (see readBudgetMs).
        for (
          let reads = 0;
          parsed?.pending && reads < pendingReads && Date.now() < deadline;
          reads++
        )
          parsed = parseModelsList(await read(true));
        if (!parsed) throw Error("Unexpected models.list result");
        if (parsed.pending)
          throw Object.assign(Error("ChatGPT model discovery still running"), {
            code: "PENDING",
          });
        this.#result = parsed;
        this.#failed = false;
      } catch (error) {
        this.#failed = true;
        this.warn(`ChatGPT model list could not be read (${errorCode(error)}).`);
        throw error;
      } finally {
        this.#attemptedAt = this.now();
        this.#inflight = null;
        this.onChange();
      }
    })();
    return this.#inflight;
  }
}
