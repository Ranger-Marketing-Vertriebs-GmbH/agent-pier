import { endpointRequest, authHeaders } from "./endpoint-http.js";
import { listEndpointModels, mergeModels } from "./endpoint-models.js";
import { probes } from "./endpoint-probe-plan.js";
import { probeCapabilities } from "./endpoint-capability-probe.js";

const PROBE_TIMEOUT = 90_000;
const TOTAL_TIMEOUT = 180_000;

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
  const planned = probes(endpoint, model);
  const results = {};
  for (const [name, probe] of Object.entries(planned)) {
    if (!model || !probe) continue;
    try {
      results[name] = await endpointRequest({
        url: probe.url,
        method: "POST",
        body: probe.body,
        headers: { ...headers, ...(probe.headers || {}) },
        timeoutMs: PROBE_TIMEOUT,
        signal: combined,
        lookup,
      });
    } catch (error) {
      results[name] = { reason: error.reason || "network" };
    }
  }
  // When any protocol answered the probe model with 2xx, the model exists, so a 404
  // elsewhere means the protocol is missing, even for a model the listing did not report.
  // A 400/422 is no proof: OpenAI-style servers reject unknown models with 400.
  const accepted = Object.values(results).some(
    ({ reason, status }) => !reason && status >= 200 && status < 300,
  );
  for (const name of Object.keys(planned)) {
    if (!results[name]) {
      protocols[name] = "skipped";
      continue;
    }
    const outcome = classifyProbe(results[name], {
      listedModel: listedModel || accepted,
    });
    protocols[name] = outcome.status;
    if (outcome.reason) reasons[name] = outcome.reason;
    if (outcome.warning) warnings.add(outcome.warning);
  }
  const capabilities = model
    ? await probeCapabilities({
        endpoint,
        apiKey,
        model,
        results,
        signal: combined,
        lookup,
      })
    : {};
  return {
    models,
    listed: detection.listed,
    protocols,
    reasons,
    capabilities,
    probeModelId: model,
    warnings: [...warnings],
  };
}
