import { apiCopy as copy } from "./i18n/messages/components.js";
import { memoryCopy } from "./i18n/messages/memory.js";
import { sshProjectCopy } from "./i18n/messages/ssh-projects.js";
export async function apiError(response) {
  if (response.status === 401)
    window.dispatchEvent(new Event("agentpier-login-required"));
  const data = await response.json().catch(() => ({}));
  const error = new Error(
    data.code === "MEMORY_DISCOVERY_CONFIG"
      ? memoryCopy.discoveryError
      : sshProjectCopy.errors[data.code]
        ? sshProjectCopy.errors[data.code]
        : data.error || copy.requestFailed(response.status),
  );
  error.status = response.status;
  error.code = data.code;
  return error;
}
export default async function api(path, method = "GET", body, signal) {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: body
      ? {
          "Content-Type": "application/json",
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await apiError(response);
  const data = await response.json().catch(() => ({}));
  return data;
}
