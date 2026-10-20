import { assistantProblem } from "../assistants/assistant-validation.js";
import { isShared, userLevels } from "./user-access.js";
import { userProblem } from "./user-errors.js";

// Settings no user ever changes: the hard lock, the model and the owner's bindings.
const lockedKeys = new Set([
  "shell",
  "browserVisible",
  "confirmShell",
  "confirmFull",
  "confirmInstructions",
  "confirmStdio",
  "mcpServers",
  "skills",
  "heartbeat",
  "model",
  "userAccess",
]);
const personal = ["name", "avatar", "instructions"];
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const levelProblem = () => userProblem("USER_LEVEL");

/**
 * What a user may change on an agent at her level. Shared agents affect everyone and
 * stay the owner's at every level; on her own agent "personalize" covers name,
 * picture and instructions (the personality is part of them), "extended" adds the
 * capabilities the owner released.
 */
export function editableFields(agent, level) {
  if (isShared(agent) || !userLevels.includes(level) || level === "chat") return [];
  return level === "extended" ? [...personal, "capabilities"] : [...personal];
}

const released = (agent) => agent.userAccess?.released || [];

/** The settings view of a user's agent: what it is and what she may change. */
export function settingsView(agent, level) {
  return {
    revision: agent.revision,
    fields: editableFields(agent, level),
    values: {
      name: agent.name,
      avatar: agent.avatar ?? null,
      instructions: agent.instructions ?? "",
      ...(released(agent).length && {
        capabilities: Object.fromEntries(
          released(agent).map((key) => [key, agent.capabilities?.[key] === true]),
        ),
      }),
    },
    level,
    shared: isShared(agent),
    released: released(agent),
  };
}

/**
 * The agent patch for a user's change: 400 for anything locked or malformed, 403
 * USER_LEVEL for a field or capability beyond her level or the owner's release.
 */
export function settingsPatch(agent, level, values) {
  if (!record(values)) throw assistantProblem("invalid");
  const keys = Object.keys(values);
  if (keys.some((key) => lockedKeys.has(key))) throw assistantProblem("invalid");
  const fields = editableFields(agent, level);
  if (keys.some((key) => !fields.includes(key))) throw levelProblem();
  const patch = Object.fromEntries(
    keys.filter((key) => key !== "capabilities").map((key) => [key, values[key]]),
  );
  if ("capabilities" in values) {
    const capabilities = values.capabilities;
    if (!record(capabilities)) throw assistantProblem("invalid");
    if (Object.keys(capabilities).some((key) => !released(agent).includes(key)))
      throw levelProblem();
    if (Object.values(capabilities).some((value) => typeof value !== "boolean"))
      throw assistantProblem("invalid");
    patch.capabilities = { ...agent.capabilities, ...capabilities };
  }
  return patch;
}
