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
  constructor({ connections, accounts }) {
    Object.assign(this, { connections, accounts });
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
      const provider =
        connection.providerId === "endpoint"
          ? assistantEndpointProvider(connection, modelId, apiKey)
          : {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              apiKey,
              models: [{ id: modelId, name: modelId }],
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
