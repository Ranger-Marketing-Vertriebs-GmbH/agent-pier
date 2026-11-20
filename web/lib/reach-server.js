import { observeBuild } from "./build-check.js";
import { apiCopy as copy } from "./i18n/messages/components.js";

/**
 * fetch() for AgentPier's own routes. A request that never reaches the server (the
 * service is down, the network is gone) rejects with the browser's own TypeError,
 * "Failed to fetch" or "Load failed", in English whatever the UI language is. It
 * becomes a translated error with the stable code UNREACHABLE. Aborts stay as they
 * are, so callers can still tell their own cancellation apart. Every answer passes
 * the build check (build-check.js).
 */
export async function reachServer(url, init) {
  try {
    return observeBuild(await fetch(url, init));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw unreachableError(error);
  }
}

export function unreachableError(cause) {
  const failure = new Error(copy.unreachable, { cause });
  failure.code = "UNREACHABLE";
  return failure;
}
