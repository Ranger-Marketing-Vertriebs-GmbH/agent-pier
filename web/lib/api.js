import { observeBuild } from "./build-check.js";
import { serverMessagesReady, serverProblemText } from "./server-messages.js";
import { artifactCopy } from "./i18n/messages/artifacts.js";
import { apiCopy as copy } from "./i18n/messages/components.js";
import { memoryCopy } from "./i18n/messages/memory.js";
import { secretsCopy } from "./i18n/messages/secrets.js";
import { sshProjectCopy } from "./i18n/messages/ssh-projects.js";
export async function apiError(response) {
  if (response.status === 401)
    window.dispatchEvent(new Event("agentpier-login-required"));
  const data = await response.json().catch(() => ({}));
  if (data.messageKey) await serverMessagesReady();
  const error = new Error(
    data.code === "MEMORY_DISCOVERY_CONFIG"
      ? memoryCopy.discoveryError
      : sshProjectCopy.errors[data.code]
        ? sshProjectCopy.errors[data.code]
        : // SECRET_INVALID has one text per field; the server's translated text stays.
          secretsCopy.errors[data.code] ||
          artifactCopy.errors[data.code] ||
          serverProblemText(data, copy.requestFailed(response.status)),
  );
  error.status = response.status;
  error.code = data.code;
  // A stable identifier for callers that branch on the reason, never on text.
  if (typeof data.messageKey === "string") error.messageKey = data.messageKey;
  // The form field a refused value belongs to, and the header or variable names.
  if (typeof data.field === "string") error.field = data.field;
  if (Array.isArray(data.names))
    error.names = data.names.filter((item) => typeof item === "string");
  // Agents affected by a connection change, named in its confirmation.
  if (data.affected && typeof data.affected === "object") error.affected = data.affected;
  // Agents a dreaming switch names: memory to confirm, or busy right now.
  if (Array.isArray(data.agents))
    error.agents = data.agents
      .filter((agent) => agent && typeof agent.name === "string")
      .map(({ id, name }) => ({ id, name }));
  // The outdated CLI behind a refused launch: { tool, found, required }.
  if (data.updateRequired && typeof data.updateRequired === "object")
    error.updateRequired = data.updateRequired;
  // Confirmations the server still needs, such as raising an agent's shell level.
  if (Array.isArray(data.required))
    error.required = data.required.filter((item) => typeof item === "string");
  return error;
}
export default async function api(path, method = "GET", body, signal) {
  const response = observeBuild(
    await fetch(`/api${path}`, {
      method,
      signal,
      headers: body
        ? {
            "Content-Type": "application/json",
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  if (!response.ok) throw await apiError(response);
  const data = await response.json().catch(() => ({}));
  return data;
}
