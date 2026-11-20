import { loginCopy as copy } from "../../lib/i18n/messages/login.js";
import { reachServer, unreachableError } from "../../lib/reach-server.js";
// A sign-in that gets no answer within 15 s counts as an unreachable AgentPier.
async function reach(url, init) {
  try {
    return await reachServer(url, init);
  } catch (error) {
    if (error?.name === "TimeoutError") throw unreachableError(error);
    throw error;
  }
}
export async function loginRequest(action, body) {
  const response = await reach(`/auth/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok)
    throw new Error(
      Object.hasOwn(copy.errors, data.code) ? copy.errors[data.code] : copy.failed,
    );
  return data;
}
export function announceLoginChange() {
  try {
    localStorage.setItem("agentpier-auth-change", String(Date.now()));
  } catch {}
}
