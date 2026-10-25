import { sameValue } from "../../../lib/settings/draft-state.js";
import { sortedIds, sortedLevels } from "./agent-settings-fields.js";

// The on/off rights of a hook, in the order the detail page lists them.
export const hookTicks = ["notify", "telegram", "research", "coding", "memory", "mcp"];
const rightKeys = [...hookTicks, "shell", "sshHosts", "folders"];
const plainKeys = ["name", "sender", "instruction", "hourlyLimit", "enabled"];

/**
 * Why a tick cannot be switched on ("missing": the agent lacks the right,
 * "needsNotify": Telegram without Notify) and whether it is locked. A stored tick
 * the agent no longer allows stays switchable off: lowering is always allowed.
 */
export function tickLock(key, ceiling, values) {
  let reason = null;
  if (key !== "notify" && ceiling[key] !== true) reason = "missing";
  else if (key === "telegram" && !values.notify) reason = "needsNotify";
  return { reason, locked: Boolean(reason) && values[key] !== true };
}

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

const levelRank = ["none", "read", "write"];

/**
 * A proposal's rights with the owner's edited ticks, each capped by what the agent
 * holds now (`ceiling`, `shellChoices` of hookApi.list): an approval never asks for
 * more than the server accepts. Telegram needs Notify.
 */
export function clampRights(rights, ticks, ceiling, shellChoices) {
  const values = { ...rights, ...ticks };
  const on = (key) => values[key] === true && (key === "notify" || ceiling[key] === true);
  const folders = {};
  for (const [project, level] of Object.entries(rights.folders || {})) {
    const held = ceiling.folders?.[project];
    if (!held) continue;
    folders[project] = levelRank.indexOf(level) > levelRank.indexOf(held) ? held : level;
  }
  return {
    ...Object.fromEntries(hookTicks.map((key) => [key, on(key)])),
    telegram: on("telegram") && on("notify"),
    shell: shellChoices.includes(rights.shell) ? rights.shell : "off",
    sshHosts: (rights.sshHosts || []).filter((host) => ceiling.sshHosts?.includes(host)),
    folders,
  };
}

/** Whether a proposal asks for more than the agent holds now (see clampRights). */
export function exceedsCeiling(rights, ceiling, shellChoices) {
  const capped = clampRights(rights, {}, ceiling, shellChoices);
  return (
    hookTicks.some((key) => capped[key] !== (rights[key] === true)) ||
    capped.shell !== (rights.shell || "off") ||
    capped.sshHosts.length !== (rights.sshHosts || []).length ||
    Object.entries(rights.folders || {}).some(
      ([project, level]) => capped.folders[project] !== level,
    )
  );
}
