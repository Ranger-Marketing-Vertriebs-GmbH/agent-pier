import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { validModelId } from "../providers/provider-definitions.js";
import {
  assistantEndpointProvider,
  endpointCapability,
} from "./assistant-provider-endpoint.js";
export class AssistantModels {
  #transports = new Map();
  // `catalog` is the central provider catalog (providers/provider-catalog.js).
  constructor({ connections, accounts, catalog }) {
    Object.assign(this, { connections, accounts, catalog });
  }
  // OpenRouter lists input modalities per model; a model outside the catalog
  // stays text-only, as the runtime treats a provider model without `input`.
  #openRouterImages(modelId) {
    try {
      return this.catalog?.get("openrouter", modelId).capabilities?.imageInput === true;
    } catch {
      return false;
    }
  }
  /**
   * The model's price as OpenClaw's model entry takes it (`cost`, USD per 1M
   * tokens), from the provider catalog, or null without a known input and output
   * price (a model outside the catalog, dynamic pricing). OpenClaw estimates a call's
   * cost from it when OpenRouter's answer names none (openclaw-usage.js); a custom
   * provider has no other price. A model without a cache price of its own is billed
   * its input price for cached input.
   */
  #openRouterCost(modelId) {
    let pricing;
    try {
      pricing = this.catalog?.get("openrouter", modelId).pricing;
    } catch {
      return null;
    }
    const price = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
    const input = price(pricing?.inputPerMTok);
    const output = price(pricing?.outputPerMTok);
    if (input === null || output === null) return null;
    return {
      input,
      output,
      cacheRead: price(pricing.cacheReadPerMTok) ?? input,
      cacheWrite: price(pricing.cacheWritePerMTok) ?? input,
    };
  }
  /**
   * Whether the Gateway shows images to this model, from the same facts the
   * compiled provider declares; null when the connection is unknown. ChatGPT
   * accounts run OpenAI's multimodal models.
   */
  imageInput({ connectionId, modelId } = {}) {
    if (typeof connectionId === "string" && connectionId.startsWith("openclaw:"))
      return true;
    let connection;
    try {
      connection = this.connections.get(connectionId);
    } catch {
      return null;
    }
    if (connection?.providerId === "openrouter") return this.#openRouterImages(modelId);
    if (connection?.providerId === "endpoint")
      return (
        connection.endpoint?.models?.find((m) => m.modelId === modelId)?.images === true
      );
    return null;
  }
  listCapabilities() {
    return [
      ...(this.accounts?.capabilities() || []),
      ...this.connections.list().map((connection) => {
        const { id, name, providerId, hasSecret } = connection;
        return {
          id,
          name,
          providerId,
          // The preset names the provider ("Azure OpenAI") as the connection list does.
          ...(providerId === "endpoint" && connection.endpoint?.preset
            ? { endpoint: { preset: connection.endpoint.preset } }
            : {}),
          ...(providerId === "endpoint"
            ? endpointCapability(connection)
            : {
                available: providerId === "openrouter" && hasSecret,
                ...(providerId !== "openrouter"
                  ? { reason: "unsupportedProvider" }
                  : !hasSecret
                    ? { reason: "credentialsRequired" }
                    : {}),
              }),
        };
      }),
    ];
  }
  resolve({ connectionId, modelId }) {
    textValue(modelId, 256);
    if (
      typeof connectionId === "string" &&
      connectionId.startsWith("openclaw:") &&
      this.accounts
    )
      return this.accounts.resolve(connectionId, modelId);
    if (!validModelId(modelId)) throw assistantProblem("invalid");
    const connection = this.connections.get(connectionId);
    if (!["openrouter", "endpoint"].includes(connection.providerId))
      throw assistantProblem("provider");
    const release = this.connections.acquire(connectionId);
    try {
      const apiKey = this.connections.secret(connectionId)?.apiKey;
      if (connection.providerId === "openrouter" && !apiKey)
        throw assistantProblem("provider");
      const cost =
        connection.providerId === "openrouter" ? this.#openRouterCost(modelId) : null;
      const provider =
        connection.providerId === "endpoint"
          ? assistantEndpointProvider(connection, modelId, apiKey)
          : {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              apiKey,
              models: [
                {
                  id: modelId,
                  name: modelId,
                  ...(this.#openRouterImages(modelId) && { input: ["text", "image"] }),
                  ...(cost && { cost }),
                },
              ],
            };
      // Native models.json and config.patch merge old provider fields. A new
      // transport identity prevents stale endpoints/keys/headers surviving edits.
      // IDs are opaque, not publicly reproducible hashes of credential material.
      // A fresh process also gets fresh IDs; offline preparation removes stale
      // connection providers before installing the current transport references.
      const key = JSON.stringify([connectionId, modelId]);
      let transport = this.#transports.get(key);
      if (!transport || !isDeepStrictEqual(transport.provider, provider)) {
        transport = {
          provider: structuredClone(provider),
          id: `ap-${connectionId}-${randomUUID()}`,
        };
        this.#transports.set(key, transport);
      }
      const providerId = transport.id;
      return {
        providerId,
        // The connection's kind ("endpoint": the owner's own, often a small or local
        // model, which a runtime may treat with more care; "openrouter").
        kind: connection.providerId,
        modelRef: `${providerId}/${modelId}`,
        provider,
        // What the owner sees; the agent names these instead of the opaque provider.
        display: { connection: connection.name, model: provider.models[0].name },
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }
}
