import api from "../../lib/api.js";
import { endpointPayload, initialEndpoint } from "./endpoint-draft.js";

/** The draft fields of one provider connection subpage. */
export function connectionValues(connection) {
  return {
    name: connection?.name || "",
    providerId: connection?.providerId || "openrouter",
    apiKey: "",
    removeApiKey: false,
    responsesAccess: Boolean(connection?.responsesAccess),
    endpoint: initialEndpoint(connection),
  };
}

/** The request body the connection dialog sent, plus confirmed flags. */
export function connectionBody(values, connection, confirmations = {}) {
  const endpoint = values.providerId === "endpoint";
  return {
    name: values.name.trim(),
    ...(!connection ? { providerId: values.providerId } : {}),
    ...(values.apiKey ? { apiKey: values.apiKey } : {}),
    ...(values.removeApiKey ? { removeApiKey: true } : {}),
    ...(values.providerId !== "openrouter" &&
    !endpoint &&
    (!connection || values.responsesAccess !== Boolean(connection.responsesAccess))
      ? { responsesAccess: values.responsesAccess }
      : {}),
    ...(endpoint ? { endpoint: endpointPayload(values.endpoint) } : {}),
    ...confirmations,
  };
}

/**
 * Saves a connection in one request. Changing one that agents use asks to restart
 * their Gateway first (ASSISTANT_RESTART_REQUIRED → confirmRestart).
 */
export function connectionSaveStep({ connection, label, request = api, saved }) {
  return {
    id: "connection",
    label,
    async run({ values, confirmations }) {
      const result = await request(
        connection
          ? `/provider-connections/${encodeURIComponent(connection.id)}`
          : "/provider-connections",
        connection ? "PATCH" : "POST",
        connectionBody(values, connection, confirmations),
      );
      await saved(result);
      return result;
    },
  };
}
