import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
// The key travels with the error so agent tools can name a stable reason.
export const assistantProblem = (key, status = 400) =>
  Object.assign(problem(serverMessages.assistants[key], status), { key });
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
          "confirmInstructions",
        ].includes(k),
    ) ||
    ("confirmInstructions" in input && (!partial || input.confirmInstructions !== true))
  )
    throw assistantProblem("invalid");
  const result = {};
  if (input.confirmInstructions === true) result.confirmInstructions = true;
  if ("capabilities" in input) {
    const c = input.capabilities;
    if (
      !c ||
      Array.isArray(c) ||
      Object.keys(c).some((k) => !["memory", "reminders"].includes(k)) ||
      typeof c.memory !== "boolean" ||
      typeof c.reminders !== "boolean"
    )
      throw assistantProblem("invalid");
    result.capabilities = { memory: c.memory, reminders: c.reminders };
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
