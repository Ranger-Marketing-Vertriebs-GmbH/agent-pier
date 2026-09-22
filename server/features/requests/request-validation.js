import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { previewLimit, notesLimit } from "./native-questions.js";
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
        ...(string(option.preview, previewLimit) && option.preview.trim()
          ? { preview: option.preview }
          : {}),
        ...(["once", "turn", "session", "persistent"].includes(option.scope)
          ? { scope: option.scope }
          : {}),
      };
    });
    if (new Set(result.map((x) => x.id)).size !== result.length) throw invalid();
    return result;
  };
  const result = { kind: value.kind };
  if (
    value.presentation === "codexHookTrust" &&
    value.kind === "permission" &&
    Number.isInteger(value.hookCount) &&
    value.hookCount > 0 &&
    value.hookCount <= 100
  ) {
    result.presentation = value.presentation;
    result.hookCount = value.hookCount;
  }
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
        ...(q.notes === true ? { notes: true } : {}),
        ...(q.secret === true ? { secret: true } : {}),
      };
    });
    if (value.declinable === true) result.declinable = true;
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
  if (input.choice !== undefined) throw invalid();
  const notes = notesValue(request, input.notes);
  if (input.decline !== undefined) {
    if (input.decline !== true || !request.declinable || input.answers !== undefined)
      throw invalid();
    return { decline: true, ...(notes ? { notes } : {}) };
  }
  if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers))
    throw invalid();
  if (Object.keys(input.answers).length !== request.questions.length) throw invalid();
  const answers = Object.create(null);
  for (const question of request.questions) {
    const raw = input.answers[question.id];
    if (
      !Array.isArray(raw) ||
      raw.length > 100 ||
      raw.some((v) => !string(v) || !v.trim())
    )
      throw invalid();
    // A free-text answer that repeats a selected label adds nothing; drop it.
    const values = raw.filter(
      (v, i) => raw.findIndex((other) => other.trim() === v.trim()) === i,
    );
    if (!values.length || (!question.multiple && values.length !== 1)) throw invalid();
    if (
      !question.allowOther &&
      values.some((v) => !question.options.some((o) => o.id === v))
    )
      throw invalid();
    answers[question.id] = values;
  }
  return { answers, ...(notes ? { notes } : {}) };
}
function notesValue(request, input) {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  // Keys are checked against question IDs, so a plain object is safe here.
  const notes = {};
  for (const [id, value] of Object.entries(input)) {
    const question = request.questions.find((q) => q.id === id);
    if (!question?.notes || !string(value, notesLimit)) throw invalid();
    if (value.trim()) notes[id] = value.trim();
  }
  return Object.keys(notes).length ? notes : null;
}
