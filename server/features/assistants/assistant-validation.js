import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { capabilityKeys, shellLevels } from "./native-capabilities.js";
import { validateHeartbeat } from "./heartbeat-schedule.js";
// The key travels with the error so agent tools can name a stable reason.
export const assistantProblem = (key, status = 400) =>
  Object.assign(problem(serverMessages.assistants[key], status), { key });
// OpenClaw skill names (agent-skills.js); a list holds at most `maxSkills` of them.
export const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const maxSkills = 64;
/** A submitted skill list: sorted names without duplicates, or a 400. */
export function validateSkills(value) {
  if (
    !Array.isArray(value) ||
    value.length > maxSkills ||
    value.some((name) => typeof name !== "string" || !skillNamePattern.test(name))
  )
    throw assistantProblem("invalid");
  return [...new Set(value)].sort();
}
export function textValue(value, max = 65536, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max ||
    value.includes("\0")
  )
    throw assistantProblem("invalid");
  return value;
}
// The owner's chat turn: text, an optional team permission and staged upload ids.
export function validateSendInput(input) {
  const keys = ["clientRequestId", "text", "teamAllowed", "attachments"];
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    ("teamAllowed" in input && typeof input.teamAllowed !== "boolean") ||
    ("attachments" in input && !Array.isArray(input.attachments))
  )
    throw assistantProblem("invalid");
}
export function validateDefinition(input, partial = false) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "name",
          "instructions",
          "model",
          "capabilities",
          "shell",
          "browserVisible",
          "skills",
          "heartbeat",
          "confirmInstructions",
        ].includes(k),
    ) ||
    ("confirmInstructions" in input && (!partial || input.confirmInstructions !== true))
  )
    throw assistantProblem("invalid");
  const result = {};
  if (input.confirmInstructions === true) result.confirmInstructions = true;
  if ("shell" in input) {
    if (!shellLevels.includes(input.shell)) throw assistantProblem("invalid");
    result.shell = input.shell;
  }
  if ("browserVisible" in input) {
    if (typeof input.browserVisible !== "boolean") throw assistantProblem("invalid");
    result.browserVisible = input.browserVisible;
  }
  if ("skills" in input) result.skills = validateSkills(input.skills);
  if ("heartbeat" in input) result.heartbeat = validateHeartbeat(input.heartbeat);
  if ("capabilities" in input) {
    const c = input.capabilities;
    if (
      !c ||
      Array.isArray(c) ||
      Object.keys(c).some((k) => !capabilityKeys.includes(k)) ||
      typeof c.memory !== "boolean" ||
      typeof c.reminders !== "boolean" ||
      Object.values(c).some((v) => typeof v !== "boolean")
    )
      throw assistantProblem("invalid");
    result.capabilities = Object.fromEntries(
      capabilityKeys.filter((k) => k in c).map((k) => [k, c[k]]),
    );
  }
  if (!partial || "name" in input) result.name = textValue(input.name, 100).trim();
  if (!partial || "instructions" in input)
    result.instructions = textValue(input.instructions ?? "", 65536, true);
  if (!partial || "model" in input) {
    const model = input.model;
    if (
      !model ||
      Object.keys(model).some((k) => !["connectionId", "modelId"].includes(k))
    )
      throw assistantProblem("invalid");
    result.model = {
      connectionId: textValue(model.connectionId, 100),
      modelId: textValue(model.modelId, 256),
    };
  }
  return result;
}
