import { assistantProblem } from "../assistant-validation.js";
import { mailDefinition } from "../team-plugin/mail-tool.js";

// The tool's own JSON schema (team-plugin/mail-tool.js) checked again in AgentPier:
// the Gateway's validation is not a boundary AgentPier relies on.
const schema = mailDefinition.mail.parameters;
const maxRecipients = 50;

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function fits(rule, value) {
  if (rule.type === "boolean") return typeof value === "boolean";
  if (rule.type === "integer")
    return (
      Number.isSafeInteger(value) &&
      (rule.minimum === undefined || value >= rule.minimum) &&
      (rule.maximum === undefined || value <= rule.maximum)
    );
  if (rule.type === "string")
    return (
      typeof value === "string" &&
      value.length >= (rule.minLength ?? 0) &&
      (rule.maxLength === undefined || value.length <= rule.maxLength) &&
      (!rule.enum || rule.enum.includes(value)) &&
      (!rule.pattern || new RegExp(rule.pattern).test(value))
    );
  if (rule.type === "array")
    return (
      Array.isArray(value) &&
      value.length <= rule.maxItems &&
      value.every((item) => fits(rule.items, item))
    );
  if (rule.type === "object")
    return (
      plain(value) &&
      Object.entries(value).every(
        ([key, item]) =>
          Object.hasOwn(rule.properties, key) && fits(rule.properties[key], item),
      ) &&
      (rule.required || []).every((key) => Object.hasOwn(value, key))
    );
  return false;
}

/**
 * The tool input within the schema's limits, or 400 `invalid`; a `query` without a
 * single criterion is 400 `mailQueryEmpty`. Which fields an action needs is its own
 * check (agent-mail.js and the action modules).
 */
export function mailInput(raw) {
  if (!fits(schema, raw)) throw assistantProblem("invalid");
  const recipients = ["to", "cc", "bcc"].reduce((n, k) => n + (raw[k]?.length ?? 0), 0);
  if (recipients > maxRecipients) throw assistantProblem("invalid");
  if (raw.query && !Object.keys(raw.query).length)
    throw assistantProblem("mailQueryEmpty");
  return raw;
}
