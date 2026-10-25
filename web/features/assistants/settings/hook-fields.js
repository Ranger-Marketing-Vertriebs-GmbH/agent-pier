import { sameValue } from "../../../lib/settings/draft-state.js";
import { sortedIds, sortedLevels } from "./agent-settings-fields.js";

// The on/off rights of a hook, in the order the detail page lists them.
export const hookTicks = ["notify", "telegram", "research", "coding", "memory", "mcp"];
const rightKeys = [...hookTicks, "shell", "sshHosts", "folders"];
const plainKeys = ["name", "sender", "instruction", "hourlyLimit", "enabled"];

/** A hook as draft values of its detail page: one key per field, rights flattened. */
export function hookDraft(hook) {
  const rights = hook.rights;
  return {
    name: hook.name,
    sender: hook.sender,
    instruction: hook.instruction ?? "",
    ...Object.fromEntries(hookTicks.map((key) => [key, rights[key] === true])),
    shell: rights.shell,
    sshHosts: sortedIds(rights.sshHosts),
    folders: sortedLevels(rights.folders),
    hourlyLimit: hook.hourlyLimit,
    enabled: hook.enabled,
  };
}

/**
 * The PATCH body of an edited hook: its revision and the changed fields. A changed
 * right sends all rights; the untouched ones go back as stored, so a right above a
 * since-lowered ceiling stays as it is (the server caps it live).
 */
export function hookPatch(values, hook) {
  const saved = hookDraft(hook);
  const patch = { revision: hook.revision };
  for (const key of plainKeys)
    if (!sameValue(values[key], saved[key])) patch[key] = values[key];
  if (rightKeys.some((key) => !sameValue(values[key], saved[key])))
    patch.rights = {
      ...Object.fromEntries(hookTicks.map((key) => [key, values[key]])),
      shell: values.shell,
      sshHosts: values.sshHosts,
      folders: values.folders,
    };
  return patch;
}

/** The address a sample request uses: the one other machines reach most likely. */
export const hookAddress = (addresses) =>
  addresses.tailscale || addresses.network[0] || addresses.local;

export const curlSample = (secret, address) =>
  `curl -X POST -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '{"id":"1","message":"test"}' ${address}`;

/** Why a hook does (not) wake its agent: no secret yet, paused, agent not eligible. */
export function hookState(hook) {
  if (!hook.enabled) return "paused";
  if (!hook.active) return "inactive";
  return hook.secretSet ? "active" : "noSecret";
}
