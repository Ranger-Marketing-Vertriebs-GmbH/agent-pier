import { loginCopy as copy } from "../../lib/i18n/messages/login.js";
export async function loginRequest(action, body) {
  const response = await fetch(`/auth/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || copy.failed);
  return data;
}
export function announceLoginChange() {
  try {
    localStorage.setItem("agentpier-auth-change", String(Date.now()));
  } catch {}
}
