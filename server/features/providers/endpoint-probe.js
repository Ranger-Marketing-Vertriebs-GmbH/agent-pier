import { endpointRequest, authHeaders } from "./endpoint-http.js";
import { listEndpointModels, mergeModels } from "./endpoint-models.js";

const PROBE_TIMEOUT = 90_000;
const TOTAL_TIMEOUT = 180_000;
const trim = (url) => String(url || "").replace(/\/+$/, "");

/**
 * Maps one probe response to a protocol status. Only fixed reason identifiers leave
 * this function, so upstream response text can never reach a result or an error.
 */
export function classifyProbe(result, { listedModel }) {
  if (result.reason)
    return {
      status: "failed",
      reason: result.reason === "notAllowed" ? "network" : result.reason,
    };
  const { status, json } = result;
  if (status >= 200 && status < 300)
    return json ? { status: "ok" } : { status: "failed", reason: "invalidResponse" };
  if (status === 400 || status === 422)
    return { status: "ok", warning: "rejectedRequest" };
  if ([404, 405, 501].includes(status))
    return listedModel
      ? { status: "unsupported", reason: "notFound" }
      : { status: "failed", reason: "modelNotFound" };
  if (status === 401 || status === 403) return { status: "failed", reason: "auth" };
  return { status: "failed", reason: "http" };
}

function probes(endpoint, model) {
  const ask = [{ role: "user", content: "ok" }];
  return {
    messages: endpoint.anthropicBaseUrl && {
      url: `${trim(endpoint.anthropicBaseUrl)}/v1/messages`,
      body: { model, max_tokens: 1, messages: ask },
      headers: { "anthropic-version": "2023-06-01" },
    },
    responses: {
      url: `${trim(endpoint.openaiBaseUrl)}/responses`,
      body: { model, input: "ok", max_output_tokens: 16 },
    },
    chatCompletions: {
      url: `${trim(endpoint.openaiBaseUrl)}/chat/completions`,
      body: { model, max_tokens: 1, messages: ask },
    },
  };
}

export async function runEndpointTest({
  endpoint,
  apiKey,
  probeModelId,
  previousModels = [],
  signal,
  lookup,
}) {
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const detection = await listEndpointModels({
    endpoint,
    apiKey,
    signal: combined,
    lookup,
  });
  const models = mergeModels(previousModels, detection);
  const listedIds = new Set(detection.models.map((model) => model.modelId));
  const model =
    probeModelId || detection.models[0]?.modelId || models[0]?.modelId || null;
  const listedModel = listedIds.has(model);
  const warnings = new Set(detection.warnings);
  const keptDetected = models.filter((item) => item.source === "detected").length;
  if (detection.listed && keptDetected < detection.models.length)
    warnings.add("modelListTruncated");
  const protocols = {};
  const reasons = {};
  const headers = authHeaders(apiKey, endpoint.authHeader);
  for (const [name, probe] of Object.entries(probes(endpoint, model))) {
    if (!model || !probe) {
      protocols[name] = "skipped";
      continue;
    }
    let outcome;
    try {
      outcome = classifyProbe(
        await endpointRequest({
          url: probe.url,
          method: "POST",
          body: probe.body,
          headers: { ...headers, ...(probe.headers || {}) },
          timeoutMs: PROBE_TIMEOUT,
          signal: combined,
          lookup,
        }),
        { listedModel },
      );
    } catch (error) {
      outcome = classifyProbe({ reason: error.reason || "network" }, { listedModel });
    }
    protocols[name] = outcome.status;
    if (outcome.reason) reasons[name] = outcome.reason;
    if (outcome.warning) warnings.add(outcome.warning);
  }
  return {
    models,
    listed: detection.listed,
    protocols,
    reasons,
    probeModelId: model,
    warnings: [...warnings],
  };
}
