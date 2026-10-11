import { assistantProblem } from "../assistant-validation.js";

// Every live OpenClaw configuration write goes through here, so a concurrent change
// surfaces as a conflict instead of being silently overwritten. OpenClaw 2026.9.8
// rejects a stale base hash with the generic INVALID_REQUEST, so a changed hash
// after the rejection is what identifies the conflict.
export async function patchConfig(client, build) {
  const current = await client.call("config.get", {});
  const change = build(current.config || {});
  if (!change) return null;
  try {
    await client.call("config.patch", {
      baseHash: current.hash,
      raw: JSON.stringify(change.patch),
      ...(change.replacePaths ? { replacePaths: change.replacePaths } : {}),
    });
  } catch (error) {
    if (error.answered && error.code === "INVALID_REQUEST") {
      // An INVALID_REQUEST racing a concurrent write is reported as 409; a retry
      // surfaces the real error.
      const latest = await client.call("config.get", {}).catch(() => null);
      if (latest && latest.hash !== current.hash) throw assistantProblem("conflict", 409);
    }
    throw error;
  }
  return current;
}
