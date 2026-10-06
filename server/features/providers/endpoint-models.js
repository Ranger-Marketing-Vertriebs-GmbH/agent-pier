import { validModelId } from "./provider-definitions.js";
import { endpointRequest, authHeaders } from "./endpoint-http.js";

const LIST_TIMEOUT = 10_000;
const valid = (value) => Number.isInteger(value) && value >= 1024 && value <= 10_000_000;
const trim = (url) => String(url || "").replace(/\/+$/, "");
const rootUrl = (endpoint) =>
  trim(endpoint.anthropicBaseUrl) || trim(endpoint.openaiBaseUrl).replace(/\/v1$/, "");

export function parseOllamaNumCtx(parameters) {
  if (typeof parameters !== "string") return null;
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  const value = match ? Number(match[1]) : null;
  return valid(value) ? value : null;
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
  try {
    const result = await call(`${trim(endpoint.openaiBaseUrl)}/models`);
    if (result.status === 200 && Array.isArray(result.json?.data)) {
      ids = result.json.data
        .map((item) => item?.id)
        .filter((id) => typeof id === "string");
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
  const usable = [...new Set(ids)]
    .filter((id) => {
      if (validModelId(id)) return true;
      warnings.add("modelIdSkipped");
      return false;
    })
    .slice(0, 200);
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
    const router = models.length > 1;
    models = await pool(models, 4, async (model) => {
      try {
        const props = await call(
          `${root}/props${router ? `?model=${encodeURIComponent(model.modelId)}` : ""}`,
        );
        const nCtx = props.json?.default_generation_settings?.n_ctx;
        return valid(nCtx) ? { ...model, contextTokens: nCtx } : model;
      } catch {
        return model;
      }
    });
  }
  return { listed, models, warnings: [...warnings] };
}

export function mergeModels(previous, detection) {
  if (!detection.listed) return previous;
  const byId = new Map(previous.map((model) => [model.modelId, model]));
  const detected = detection.models.map((model) => {
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
  const ids = new Set(detected.map((model) => model.modelId));
  return [
    ...detected,
    ...previous.filter((model) => model.source === "manual" && !ids.has(model.modelId)),
  ];
}
