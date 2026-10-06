import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { validModelId } from "./provider-definitions.js";
import { endpointOrigins, validateEndpoint } from "./endpoint-config.js";
import { runEndpointTest } from "./endpoint-probe.js";

const DRAFT_KEYS = ["connectionId", "endpoint", "apiKey", "probeModelId"];
const ENDPOINT_KEYS = ["preset", "openaiBaseUrl", "anthropicBaseUrl", "authHeader"];
const NO_PROTOCOLS = { messages: false, responses: false, chatCompletions: false };
const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Runs one endpoint test at a time against an unsaved draft; never persists. */
export class EndpointTester {
  constructor({ connections, lookup }) {
    this.connections = connections;
    this.lookup = lookup;
    this.running = false;
  }
  draft(body) {
    const messages = serverMessages.providers;
    if (!plainObject(body) || Object.keys(body).some((key) => !DRAFT_KEYS.includes(key)))
      throw problem(messages.invalidEndpoint);
    const input = body.endpoint;
    if (
      !plainObject(input) ||
      Object.keys(input).some((key) => !ENDPOINT_KEYS.includes(key))
    )
      throw problem(messages.invalidEndpoint);
    if (
      body.apiKey !== undefined &&
      (typeof body.apiKey !== "string" ||
        body.apiKey.length > 16384 ||
        /[\x00-\x1f]/.test(body.apiKey))
    )
      throw problem(messages.invalidApiKey);
    if (body.probeModelId !== undefined && !validModelId(body.probeModelId))
      throw problem(messages.invalidModelId);
    // One validator owns URL and header rules: validate a block without protocols or models.
    const { preset, openaiBaseUrl, anthropicBaseUrl, authHeader } = validateEndpoint({
      ...input,
      protocols: NO_PROTOCOLS,
      models: [],
      lastTest: null,
    });
    return { preset, openaiBaseUrl, anthropicBaseUrl, authHeader };
  }
  async test(body, signal) {
    const endpoint = this.draft(body);
    const warnings = [];
    let apiKey = body.apiKey?.trim() || "";
    let previousModels = [];
    if (body.connectionId !== undefined) {
      const record = this.connections.record(body.connectionId);
      if (record.providerId !== "endpoint" || !record.endpoint)
        throw problem(serverMessages.providers.endpointTestConnectionInvalid);
      previousModels = record.endpoint.models;
      if (body.apiKey === undefined) {
        const same =
          JSON.stringify(endpointOrigins(endpoint)) ===
          JSON.stringify(endpointOrigins(record.endpoint));
        const stored = this.connections.secret(record.id)?.apiKey || "";
        if (same) apiKey = stored;
        else if (stored) warnings.push("storedKeyNotUsed");
      }
    }
    if (this.running) throw problem(serverMessages.providers.endpointTestBusy, 429);
    this.running = true;
    try {
      const result = await runEndpointTest({
        endpoint,
        apiKey,
        probeModelId: body.probeModelId,
        previousModels,
        signal,
        lookup: this.lookup,
      });
      return { ...result, warnings: [...new Set([...warnings, ...result.warnings])] };
    } finally {
      this.running = false;
    }
  }
}
