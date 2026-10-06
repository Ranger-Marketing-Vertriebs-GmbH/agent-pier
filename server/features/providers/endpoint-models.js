import { validModelId } from "./provider-definitions.js";
import { endpointRequest, authHeaders } from "./endpoint-http.js";

const LIST_TIMEOUT = 10_000;
export const MODEL_LIMIT = 200;
const valid = (value) => Number.isInteger(value) && value >= 1024 && value <= 10_000_000;
const trim = (url) => String(url || "").replace(/\/+$/, "");
/** Native Ollama and llama.cpp routes live beside the OpenAI routes the listing used. */
const rootUrl = (endpoint) => trim(endpoint.openaiBaseUrl).replace(/\/v1$/, "");

export function parseOllamaNumCtx(parameters) {
  if (typeof parameters !== "string") return null;
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  const value = match ? Number(match[1]) : null;
  return valid(value) ? value : null;
}

const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const CTX_FLAGS = new Set(["-c", "--ctx-size", "-ctx"]);

/** Reads the context size from a llama.cpp router's per-model launch arguments. */
export function argsContext(args) {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index]);
    const value = CTX_FLAGS.has(arg)
      ? args[index + 1]
      : arg.startsWith("--ctx-size=")
        ? arg.slice("--ctx-size=".length)
        : undefined;
    if (value === undefined) continue;
    const number = Number(value);
    return valid(number) ? number : null;
  }
  return null;
}

async function pool(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

export async function listEndpointModels({ endpoint, apiKey, signal, lookup }) {
  const headers = authHeaders(apiKey, endpoint.authHeader);
  const call = (url, options = {}) =>
    endpointRequest({
      url,
      headers,
      timeoutMs: LIST_TIMEOUT,
      signal,
      lookup,
      ...options,
    });
  const warnings = new Set();
  let ids = [];
  let listed = false;
  // A llama.cpp router reports a status object per model; a single server does not.
  const routerStatus = new Map();
  try {
    const result = await call(`${trim(endpoint.openaiBaseUrl)}/models`);
    if (result.status === 200 && Array.isArray(result.json?.data)) {
      ids = result.json.data
        .map((item) => item?.id)
        .filter((id) => typeof id === "string");
      for (const item of result.json.data)
        if (typeof item?.id === "string" && plainObject(item.status))
          routerStatus.set(item.id, item.status);
      listed = true;
    }
  } catch {
    /* Listing failures are reported through `listed`. */
  }
  const root = rootUrl(endpoint);
  if (endpoint.preset === "ollama") {
    try {
      const tags = await call(`${root}/api/tags`);
      if (tags.status === 200 && Array.isArray(tags.json?.models)) {
        ids = [
          ...new Set([
            ...ids,
            ...tags.json.models.map((item) => item?.name).filter(Boolean),
          ]),
        ];
        listed = true;
      }
    } catch {
      /* Fall back to the OpenAI listing. */
    }
  }
  const accepted = [...new Set(ids)].filter((id) => {
    if (validModelId(id)) return true;
    warnings.add("modelIdSkipped");
    return false;
  });
  if (accepted.length > MODEL_LIMIT) warnings.add("modelListTruncated");
  const usable = accepted.slice(0, MODEL_LIMIT);
  let models = usable.map((modelId) => ({
    modelId,
    label: modelId,
    contextTokens: null,
    source: "detected",
  }));
  if (endpoint.preset === "ollama")
    models = await pool(models.slice(0, 50), 4, async (model) => {
      try {
        const show = await call(`${root}/api/show`, {
          method: "POST",
          body: { model: model.modelId },
        });
        const numCtx = parseOllamaNumCtx(show.json?.parameters);
        const info = show.json?.model_info || {};
        const hint = info[`${info["general.architecture"]}.context_length`];
        if (!numCtx) warnings.add("ollamaContextUnknown");
        return {
          ...model,
          contextTokens: numCtx,
          ...(valid(hint) ? { contextHint: hint } : {}),
        };
      } catch {
        warnings.add("ollamaContextUnknown");
        return model;
      }
    }).then((head) => [...head, ...models.slice(50)]);
  if (endpoint.preset === "llamacpp") {
    const router = routerStatus.size > 0;
    models = await pool(models, 4, async (model) => {
      const status = routerStatus.get(model.modelId);
      // A router loads a model for /props?model= unless autoload=false, so only models
      // that are already loaded are asked; the others use their launch arguments.
      if (router && status?.value !== "loaded") {
        const fromArgs = argsContext(status?.args);
        return fromArgs ? { ...model, contextTokens: fromArgs } : model;
      }
      try {
        const props = await call(
          `${root}/props${
            router ? `?model=${encodeURIComponent(model.modelId)}&autoload=false` : ""
          }`,
        );
        const nCtx = props.json?.default_generation_settings?.n_ctx;
        if (valid(nCtx)) return { ...model, contextTokens: nCtx };
      } catch {
        /* Fall back to the launch arguments below. */
      }
      const fromArgs = router ? argsContext(status?.args) : null;
      return fromArgs ? { ...model, contextTokens: fromArgs } : model;
    });
  }
  return { listed, models, warnings: [...warnings] };
}

/**
 * Detected models replace the previous detected ones; manual models always survive.
 * Detected models are capped so the merged list never exceeds the saveable limit, and
 * a listed model that was added manually is never dropped by the cap.
 */
export function mergeModels(previous, detection) {
  if (!detection.listed) return previous;
  const byId = new Map(previous.map((model) => [model.modelId, model]));
  const listedIds = new Set(detection.models.map((model) => model.modelId));
  const manual = previous.filter(
    (model) => model.source === "manual" && !listedIds.has(model.modelId),
  );
  const pinned = detection.models.filter(
    (model) => byId.get(model.modelId)?.source === "manual",
  ).length;
  let budget = Math.max(0, MODEL_LIMIT - manual.length - pinned);
  const detected = detection.models
    .filter((model) => byId.get(model.modelId)?.source === "manual" || budget-- > 0)
    .map((model) => {
      const old = byId.get(model.modelId);
      return {
        modelId: model.modelId,
        label: old?.label ?? model.label,
        contextTokens: old?.contextEdited ? old.contextTokens : model.contextTokens,
        outputTokens: old?.contextEdited ? old.outputTokens : (old?.outputTokens ?? null),
        source: "detected",
        contextEdited: old?.contextEdited === true,
        ...(model.contextHint ? { contextHint: model.contextHint } : {}),
      };
    });
  return [...detected, ...manual];
}
