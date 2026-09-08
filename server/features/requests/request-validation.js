import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
const invalid = () => problem(copy.invalid, 400);
export const validSession = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const string = (value, limit = 32000) =>
  typeof value === "string" && value.length <= limit && !value.includes("\0");
export function requestValue(value) {
  if (!value || !["permission", "question"].includes(value.kind)) throw invalid();
  const options = (values) => {
    if (!Array.isArray(values) || values.length > 100) throw invalid();
    const result = values.map((option) => {
      if (!string(option?.id, 1000) || !option.id || !string(option.label, 4000))
        throw invalid();
      return {
        id: option.id,
        label: option.label,
        ...(string(option.description, 8000) ? { description: option.description } : {}),
        ...(["once", "turn", "session", "persistent"].includes(option.scope)
          ? { scope: option.scope }
          : {}),
      };
    });
    if (new Set(result.map((x) => x.id)).size !== result.length) throw invalid();
    return result;
  };
  const result = { kind: value.kind };
  if (value.subject)
    result.subject = Object.fromEntries(
      ["tool", "command", "path", "cwd", "description"]
        .filter((key) => string(value.subject[key]))
        .map((key) => [key, value.subject[key]]),
    );
  if (value.kind === "permission") {
    result.options = options(value.options);
    if (!result.options.length) throw invalid();
  } else {
    if (
      !Array.isArray(value.questions) ||
      !value.questions.length ||
      value.questions.length > 50
    )
      throw invalid();
    result.questions = value.questions.map((q) => {
      if (
        !string(q?.id, 1000) ||
        !q.id ||
        !string(q.prompt) ||
        typeof q.multiple !== "boolean" ||
        typeof q.allowOther !== "boolean"
      )
        throw invalid();
      return {
        id: q.id,
        prompt: q.prompt,
        options: options(q.options),
        multiple: q.multiple,
        allowOther: q.allowOther,
        ...(string(q.header, 1000) ? { header: q.header } : {}),
        ...(q.secret === true ? { secret: true } : {}),
      };
    });
    if (new Set(result.questions.map((q) => q.id)).size !== result.questions.length)
      throw invalid();
  }
  return result;
}
export function answerValue(request, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  if (request.kind === "permission") {
    if (
      !request.options.some((o) => o.id === input.choice) ||
      input.answers !== undefined
    )
      throw invalid();
    return { choice: input.choice };
  }
  if (
    input.choice !== undefined ||
    !input.answers ||
    typeof input.answers !== "object" ||
    Array.isArray(input.answers)
  )
    throw invalid();
  if (Object.keys(input.answers).length !== request.questions.length) throw invalid();
  const answers = Object.create(null);
  for (const question of request.questions) {
    const values = input.answers[question.id];
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > 100 ||
      (!question.multiple && values.length !== 1) ||
      values.some((v) => !string(v) || !v.trim()) ||
      new Set(values).size !== values.length
    )
      throw invalid();
    if (
      !question.allowOther &&
      values.some((v) => !question.options.some((o) => o.id === v))
    )
      throw invalid();
    answers[question.id] = [...values];
  }
  return { answers };
}
