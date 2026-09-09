import { apiCopy as copy } from "./i18n/messages/components.js";
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
  if (response.status === 401)
    window.dispatchEvent(new Event("agentpier-login-required"));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || copy.requestFailed(response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}
