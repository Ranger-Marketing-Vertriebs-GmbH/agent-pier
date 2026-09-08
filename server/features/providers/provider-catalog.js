import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { PROVIDERS, providerDefinition, validModelId } from "./provider-definitions.js";
import { catalogSnapshot } from "./catalog-snapshot.js";
import { normalizeOpenRouter, normalizeZai } from "./catalog-normalization.js";

const MAX_BYTES = 16 * 1024 * 1024;
async function readBounded(response) {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES)
    throw Error("Catalog request failed.");
  const reader = response.body?.getReader();
  if (!reader) throw Error("Catalog response is empty.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw Error("Catalog response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class ProviderCatalog {
  constructor({ dataDir, fetchImpl = fetch } = {}) {
    this.file = dataDir ? path.join(dataDir, "provider-catalogs.json") : null;
    this.fetch = fetchImpl;
    this.models = catalogSnapshot();
    this.states = Object.fromEntries(
      Object.keys(PROVIDERS).map((id) => [
        id,
        {
          source: "bundled",
          fetchedAt: this.models[id][0]?.fetchedAt,
          stale: true,
          error: null,
        },
      ]),
    );
    this.pending = new Map();
    this.raw = {};
    if (this.file) {
      try {
        const saved = readJSON(this.file, {});
        for (const id of Object.keys(PROVIDERS)) {
          if (!saved[id]) continue;
          const models = this.normalize(id, saved[id].payload, saved[id].fetchedAt);
          if (!models.length) continue;
          this.models[id] = models;
          this.raw[id] = saved[id];
          this.states[id] = {
            source: "cache",
            fetchedAt: models[0].fetchedAt,
            stale: true,
            error: null,
          };
        }
      } catch {
        /* A corrupt cache never prevents use of the verified bundled snapshot. */
      }
    }
  }
  providers() {
    return Object.values(PROVIDERS).map(({ id, name, tools }) => ({
      id,
      name,
      tools: [...tools],
    }));
  }
  status() {
    return structuredClone(this.states);
  }
  list({ providerId, tool } = {}) {
    const ids = providerId ? [providerDefinition(providerId).id] : Object.keys(PROVIDERS);
    return structuredClone(
      ids
        .flatMap((id) => this.models[id])
        .filter((model) => !tool || model.tools.includes(tool)),
    );
  }
  get(providerId, modelId, { tool } = {}) {
    providerDefinition(providerId);
    if (!validModelId(modelId)) throw problem("Invalid model ID.");
    const model = this.models[providerId].find(
      (item) => item.modelId === modelId && (!tool || item.tools.includes(tool)),
    );
    if (!model)
      throw problem(
        "Model is not in the supported provider catalog. Refresh the catalog or select another model.",
      );
    return structuredClone(model);
  }
  normalize(id, payload, fetchedAt) {
    return id === "openrouter"
      ? normalizeOpenRouter(payload, fetchedAt)
      : normalizeZai(payload, id, fetchedAt);
  }
  refresh(id) {
    providerDefinition(id);
    if (this.pending.has(id)) return this.pending.get(id);
    const request = this.fetchCatalog(id).finally(() => this.pending.delete(id));
    this.pending.set(id, request);
    return request;
  }
  async fetchCatalog(id) {
    try {
      const response = await this.fetch(PROVIDERS[id].catalogUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/json" },
      });
      const payload = await readBounded(response);
      const fetchedAt = new Date().toISOString();
      const models = this.normalize(id, payload, fetchedAt);
      if (!models.length) throw Error("No usable coding models found.");
      const nextRaw = { ...this.raw, [id]: { payload, fetchedAt } };
      if (this.file) writePrivate(this.file, nextRaw);
      this.raw = nextRaw;
      this.models[id] = models;
      this.states[id] = { source: "remote", fetchedAt, stale: false, error: null };
      return {
        models: this.list({ providerId: id }),
        status: structuredClone(this.states[id]),
      };
    } catch {
      this.states[id] = {
        ...this.states[id],
        stale: true,
        error: "Catalog refresh failed; the previous catalog remains available.",
      };
      throw problem(this.states[id].error, 502);
    }
  }
}
