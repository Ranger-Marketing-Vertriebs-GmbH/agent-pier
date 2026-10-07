import path from "node:path";
import { normalizeEndpointUrl } from "../providers/endpoint-config.js";
import { validModelId } from "../providers/provider-definitions.js";
import { resolveCapabilities } from "../protocol-adapter/capabilities.js";

const CLIENT = ["messages", "responses"];
const UPSTREAM = ["messages", "responses", "chat"];
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const tokenCount = (value) =>
  Number.isInteger(value) && value >= 1024 && value <= 10_000_000;

function invalid(field) {
  // The message names the field only; values (keys, tokens) are never echoed.
  return new TypeError(`adapter: invalid ${field}`);
}

function check(field, ok) {
  if (!ok) throw invalid(field);
}

/** Where the adapter supervisor writes its diagnostics for a session. */
export function adapterDiagnosticsPath(directory, id) {
  return path.join(directory, `${id}.adapter.json`);
}

/**
 * Validates the private adapter block (AdapterBlock plus `diagnosticsPath`) and
 * returns a frozen copy. Throws a TypeError with a fixed message per field.
 */
export function validateAdapterConfig(value) {
  check("configuration", plain(value));
  check(
    "token",
    typeof value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.token),
  );
  check("clientProtocol", CLIENT.includes(value.clientProtocol));
  check(
    "upstreamProtocol",
    UPSTREAM.includes(value.upstreamProtocol) &&
      value.upstreamProtocol !== value.clientProtocol,
  );
  const { upstream, model } = value;
  check("upstream", plain(upstream));
  let normalized;
  try {
    normalized = normalizeEndpointUrl(upstream.baseUrl);
  } catch {
    throw invalid("upstream.baseUrl");
  }
  check("upstream.baseUrl", normalized === upstream.baseUrl);
  check(
    "upstream.authHeader",
    upstream.authHeader === null ||
      (typeof upstream.authHeader === "string" &&
        upstream.authHeader.length <= 256 &&
        HEADER_TOKEN.test(upstream.authHeader)),
  );
  check(
    "upstream.apiKey",
    upstream.apiKey === null ||
      (typeof upstream.apiKey === "string" &&
        upstream.apiKey.length <= 16384 &&
        !/[\x00-\x1f\x7f]/.test(upstream.apiKey)),
  );
  check("model", plain(model));
  check("model.modelId", validModelId(model.modelId));
  check("model.contextTokens", tokenCount(model.contextTokens));
  check(
    "model.outputTokens",
    model.outputTokens === null || tokenCount(model.outputTokens),
  );
  check("model.images", [true, false, null].includes(model.images));
  check("capabilities", plain(value.capabilities));
  try {
    resolveCapabilities(value.upstreamProtocol, value.capabilities);
  } catch {
    throw invalid("capabilities");
  }
  check("thinkTagExtraction", typeof value.thinkTagExtraction === "boolean");
  const diagnostics = value.diagnosticsPath;
  check(
    "diagnosticsPath",
    diagnostics === null ||
      (typeof diagnostics === "string" &&
        path.isAbsolute(diagnostics) &&
        !diagnostics.includes("\0")),
  );
  return Object.freeze({
    token: value.token,
    clientProtocol: value.clientProtocol,
    upstreamProtocol: value.upstreamProtocol,
    upstream: Object.freeze({
      baseUrl: upstream.baseUrl,
      authHeader: upstream.authHeader,
      apiKey: upstream.apiKey,
    }),
    model: Object.freeze({
      modelId: model.modelId,
      contextTokens: model.contextTokens,
      outputTokens: model.outputTokens,
      images: model.images,
    }),
    capabilities: Object.freeze({ ...value.capabilities }),
    thinkTagExtraction: value.thinkTagExtraction,
    diagnosticsPath: diagnostics,
  });
}

/** Session-facing wrapper: fixes the diagnostics path; `onInvalid()` builds the error. */
export function checkedAdapter(value, directory, id, onInvalid) {
  try {
    return validateAdapterConfig({
      ...value,
      diagnosticsPath: adapterDiagnosticsPath(directory, id),
    });
  } catch (error) {
    if (error instanceof TypeError) throw onInvalid();
    throw error;
  }
}
