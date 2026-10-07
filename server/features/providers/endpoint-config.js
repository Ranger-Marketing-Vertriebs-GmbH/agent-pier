import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { validModelId } from "./provider-definitions.js";
import {
  PROTOCOLS,
  resolveRoute,
  validateAdapterCapabilities,
  validateRouting,
} from "./endpoint-routing.js";

const messages = serverMessages.providers;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const BLOCK_KEYS = [
  "preset",
  "openaiBaseUrl",
  "anthropicBaseUrl",
  "protocols",
  "authHeader",
  "models",
  "lastTest",
  "routing",
  "adapterCapabilities",
  "thinkTagExtraction",
];
const MODEL_KEYS = [
  "modelId",
  "label",
  "contextTokens",
  "outputTokens",
  "source",
  "contextEdited",
  "contextHint",
  "images",
];
const STATUSES = ["ok", "unsupported", "failed", "skipped"];

export const ENDPOINT_PRESETS = Object.freeze({
  ollama: {
    openaiBaseUrl: "http://127.0.0.1:11434/v1",
    anthropicBaseUrl: "http://127.0.0.1:11434",
    protocols: { messages: true, responses: true, chatCompletions: true },
  },
  llamacpp: {
    openaiBaseUrl: "http://127.0.0.1:8080/v1",
    anthropicBaseUrl: "http://127.0.0.1:8080",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
  custom: {
    openaiBaseUrl: "",
    anthropicBaseUrl: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
});

const plainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const tokens = (value) =>
  value === null || (Number.isInteger(value) && value >= 1024 && value <= 10_000_000);

export function normalizeEndpointUrl(value, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20]/.test(value))
    throw problem(messages.invalidEndpointUrl);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(messages.invalidEndpointUrl);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  )
    throw problem(messages.invalidEndpointUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function model(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => !MODEL_KEYS.includes(key)))
    throw problem(messages.invalidEndpointModels);
  const label = value.label ?? value.modelId;
  if (
    !validModelId(value.modelId) ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 200 ||
    !tokens(value.contextTokens ?? null) ||
    !tokens(value.outputTokens ?? null) ||
    (value.contextHint !== undefined && !tokens(value.contextHint)) ||
    (value.outputTokens &&
      value.contextTokens &&
      value.outputTokens > value.contextTokens) ||
    !["detected", "manual"].includes(value.source) ||
    (value.contextEdited !== undefined && typeof value.contextEdited !== "boolean") ||
    (value.images !== undefined &&
      value.images !== null &&
      typeof value.images !== "boolean")
  )
    throw problem(messages.invalidEndpointModels);
  return {
    modelId: value.modelId,
    label: label.trim(),
    contextTokens: value.contextTokens ?? null,
    outputTokens: value.outputTokens ?? null,
    source: value.source,
    contextEdited: value.contextEdited === true,
    images: value.images ?? null,
    ...(value.contextHint ? { contextHint: value.contextHint } : {}),
  };
}

function lastTest(value) {
  if (value === null || value === undefined) return null;
  if (
    !plainObject(value) ||
    typeof value.at !== "string" ||
    Number.isNaN(Date.parse(value.at)) ||
    !plainObject(value.protocols) ||
    PROTOCOLS.some((key) => !STATUSES.includes(value.protocols[key])) ||
    (value.reasons !== undefined &&
      (!plainObject(value.reasons) ||
        Object.entries(value.reasons).some(
          ([key, reason]) => !PROTOCOLS.includes(key) || !/^[a-zA-Z]{1,40}$/.test(reason),
        )))
  )
    throw problem(messages.invalidEndpoint);
  return {
    at: value.at,
    protocols: Object.fromEntries(PROTOCOLS.map((key) => [key, value.protocols[key]])),
    reasons: { ...(value.reasons || {}) },
  };
}

export function validateEndpoint(input) {
  if (!plainObject(input) || Object.keys(input).some((key) => !BLOCK_KEYS.includes(key)))
    throw problem(messages.invalidEndpoint);
  if (!Object.hasOwn(ENDPOINT_PRESETS, input.preset))
    throw problem(messages.invalidEndpoint);
  if (
    !plainObject(input.protocols) ||
    Object.keys(input.protocols).some((key) => !PROTOCOLS.includes(key)) ||
    PROTOCOLS.some((key) => typeof input.protocols[key] !== "boolean")
  )
    throw problem(messages.invalidEndpoint);
  const authHeader = input.authHeader ?? null;
  if (
    authHeader !== null &&
    (typeof authHeader !== "string" ||
      !TOKEN.test(authHeader) ||
      FORBIDDEN_HEADERS.has(authHeader.toLowerCase()))
  )
    throw problem(messages.invalidEndpointHeader);
  if (!Array.isArray(input.models) || input.models.length > 200)
    throw problem(messages.invalidEndpointModels);
  const models = input.models.map(model);
  if (new Set(models.map((item) => item.modelId)).size !== models.length)
    throw problem(messages.invalidEndpointModels);
  if (
    input.thinkTagExtraction !== undefined &&
    typeof input.thinkTagExtraction !== "boolean"
  )
    throw problem(messages.invalidEndpoint);
  const anthropicBaseUrl = normalizeEndpointUrl(input.anthropicBaseUrl, {
    optional: true,
  });
  return {
    preset: input.preset,
    openaiBaseUrl: normalizeEndpointUrl(input.openaiBaseUrl),
    anthropicBaseUrl,
    protocols: {
      ...input.protocols,
      messages: input.protocols.messages && !!anthropicBaseUrl,
    },
    authHeader,
    models,
    lastTest: lastTest(input.lastTest),
    routing: validateRouting(input.routing),
    adapterCapabilities: validateAdapterCapabilities(input.adapterCapabilities),
    thinkTagExtraction: input.thinkTagExtraction === true,
  };
}

/**
 * A client that does not know the adapter fields (today's UI) must not reset them.
 * Absent (undefined or null) fields inherit the stored value; a provided `routing` or
 * `adapterCapabilities` object replaces the stored one as a whole (omitted tools in
 * `routing` become "auto"); a model without `images` keeps the stored flag by modelId.
 */
export function inheritAdapterSettings(input, stored) {
  if (!plainObject(input) || !stored) return input;
  const images = new Map((stored.models || []).map((m) => [m.modelId, m.images ?? null]));
  return {
    ...input,
    routing: input.routing ?? stored.routing,
    adapterCapabilities: input.adapterCapabilities ?? stored.adapterCapabilities,
    thinkTagExtraction: input.thinkTagExtraction ?? stored.thinkTagExtraction,
    models: Array.isArray(input.models)
      ? input.models.map((m) =>
          plainObject(m) && m.images === undefined && images.has(m.modelId)
            ? { ...m, images: images.get(m.modelId) }
            : m,
        )
      : input.models,
  };
}

export function endpointOrigins(endpoint) {
  return [
    ...new Set(
      [endpoint.openaiBaseUrl, endpoint.anthropicBaseUrl]
        .filter(Boolean)
        .map((url) => new URL(url).origin),
    ),
  ].sort();
}

export function endpointTools(endpoint) {
  return ["codex", "claude", "opencode"].filter((tool) => resolveRoute(endpoint, tool));
}

export function fallbackOutputTokens(contextTokens, outputTokens) {
  return outputTokens ?? Math.min(Math.floor(contextTokens / 4), 32000);
}

export function endpointModel(endpoint, modelId, tool) {
  if (!endpointTools(endpoint).includes(tool))
    throw problem(messages.endpointProtocolDisabled, 409);
  const found = endpoint.models.find((item) => item.modelId === modelId);
  if (!found) throw problem(messages.endpointModelUnknown, 409);
  if (!found.contextTokens) throw problem(messages.endpointContextRequired, 409);
  return {
    providerId: "endpoint",
    modelId: found.modelId,
    label: found.label,
    contextTokens: found.contextTokens,
    routingContextTokens: null,
    outputTokens: fallbackOutputTokens(found.contextTokens, found.outputTokens),
    images: found.images ?? null,
    tools: endpointTools(endpoint),
    source: "endpoint",
    fetchedAt: null,
  };
}
