import { codexUpstream } from "./chatgpt-proxy.js";

// The ChatGPT models of a login AgentPier holds, read by AgentPier itself from the
// Codex backend (`/codex/models`, the catalog Hermes reads too, hermes_cli/
// codex_models.py) with the login's token and account id. It serves the model
// picker while OpenClaw is not running (a Hermes-only setup); with a running Gateway
// OpenClaw's own list stays the source (model-account-catalog.js).

const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const clientVersion = "0.160.0";
const ttlMs = 10 * 60_000;
const retryMs = 60_000;
const maxModels = 500;

/** The `{ models: [{ slug, display_name, visibility, priority }] }` answer, reduced. */
export function parseCodexModels(body) {
  if (!body || !Array.isArray(body.models)) return null;
  const rows = [];
  const seen = new Set();
  for (const item of body.models) {
    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    if (!modelId.test(slug) || seen.has(slug)) continue;
    if (/^hid(e|den)$/i.test(String(item.visibility || ""))) continue;
    seen.add(slug);
    const label =
      typeof item.display_name === "string" && item.display_name.trim()
        ? item.display_name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200)
        : slug;
    const rank = Number.isFinite(item.priority) ? item.priority : 10_000;
    rows.push({ rank, modelId: slug, label });
  }
  return rows
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxModels)
    .map(({ modelId: id, label }) => ({ modelId: id, label }));
}

export class CodexCatalog {
  #entries = new Map(); // profileId -> { models, failed, at, loading }
  constructor({
    vault,
    upstream = codexUpstream,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    onChange = () => {},
    warn = console.warn,
  }) {
    Object.assign(this, { vault, upstream, fetchImpl, now, onChange, warn });
  }
  /** What the editor shows for `profileId`, never waiting. */
  account(profileId) {
    const entry = this.#entries.get(profileId);
    if (entry?.loading) return { models: entry.models || [], modelCatalog: "loading" };
    if (!entry || entry.failed || !entry.models.length)
      return { models: entry?.models || [], modelCatalog: "failed" };
    return { models: entry.models, modelCatalog: "ready" };
  }
  /** Starts background reads of the given logins whose list is stale. */
  ensure(profileIds) {
    for (const profileId of profileIds) {
      const entry = this.#entries.get(profileId);
      const age = this.now() - (entry?.at ?? -Infinity);
      if (entry?.loading || age < (entry?.failed ? retryMs : ttlMs)) continue;
      this.refresh(profileId).catch(() => {});
    }
  }
  /** Reads the list of `profileId` now; concurrent reads share one request. */
  refresh(profileId) {
    const current = this.#entries.get(profileId);
    if (current?.loading) return current.loading;
    const entry = { models: current?.models || [], failed: false, at: current?.at };
    entry.loading = this.#read(profileId)
      .then((models) => Object.assign(entry, { models, failed: false }))
      .catch((error) => {
        entry.failed = true;
        this.warn(
          `ChatGPT model list could not be read from Codex (${error?.code || "ERROR"}).`,
        );
        throw error;
      })
      .finally(() => {
        entry.loading = null;
        entry.at = this.now();
        this.onChange();
      });
    this.#entries.set(profileId, entry);
    return entry.loading;
  }
  async #read(profileId) {
    const get = async (stale) => {
      const credential = await this.vault.credential(profileId, { stale });
      const response = await this.fetchImpl(
        `${this.upstream}/codex/models?client_version=${clientVersion}`,
        {
          headers: {
            authorization: `Bearer ${credential.access}`,
            accept: "application/json",
            ...(credential.accountId && { "chatgpt-account-id": credential.accountId }),
            ...(credential.residency && {
              "x-openai-internal-codex-residency": credential.residency,
            }),
          },
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        },
      );
      return { response, credential };
    };
    let { response, credential } = await get();
    if (response.status === 401) ({ response } = await get(credential.access));
    if (!response.ok) throw Object.assign(Error(), { code: `HTTP_${response.status}` });
    const models = parseCodexModels(await response.json().catch(() => null));
    if (!models) throw Object.assign(Error(), { code: "UNEXPECTED_ANSWER" });
    return models;
  }
  forget(profileId) {
    this.#entries.delete(profileId);
  }
}
