import { assistantProblem } from "../assistant-validation.js";

// Every live OpenClaw configuration write goes through here, so a concurrent change
// surfaces as a conflict instead of being silently overwritten.
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
    if (error.answered && /CONFLICT|STALE|HASH/.test(error.code || ""))
      throw assistantProblem("conflict", 409);
    throw error;
  }
  return current;
}
