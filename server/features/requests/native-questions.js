import { cliDefinition, isCodingCli } from "../clis/catalog.js";
import { previewLimit, notesLimit } from "./question-limits.js";

export { previewLimit, notesLimit };

// Claude's native dialog withholds (and never annotates) previews longer than this.
const nativePreviewLimit = 2000;

const previewText = (option) =>
  typeof option.preview === "string" && option.preview.trim()
    ? option.preview.length > previewLimit
      ? `${option.preview.slice(0, previewLimit - 1)}…`
      : option.preview
    : null;

// Anything that is not a coding CLI keeps the plain single-answer view.
const plainView = { multiple: false, allowOther: true, previews: false, notes: false };

export function questionsView(questions, tool) {
  return questions.map((question, index) => {
    const view = isCodingCli(tool)
      ? cliDefinition(tool).questionView(question)
      : plainView;
    return {
      id: `q${index}`,
      header: question.header || "",
      prompt: question.question,
      options: (question.options || []).map((option) => {
        const preview = view.previews ? previewText(option) : null;
        return {
          id: option.label,
          label: option.label,
          description: option.description || "",
          ...(preview ? { preview } : {}),
        };
      }),
      multiple: view.multiple,
      allowOther: view.allowOther,
      ...(view.notes ? { notes: true } : {}),
      ...(question.isSecret ? { secret: true } : {}),
    };
  });
}
export function questionAnswers(questions, answers) {
  // Native labels are the selection values, so arbitrary free text cannot collide with invented IDs.
  return questions.map((_question, index) => [...answers[`q${index}`]]);
}
/**
 * Mirrors the annotations Claude's native AskUserQuestion dialog returns: the
 * selected option's preview (single choice only) and trimmed user notes.
 */
export function claudeAnnotations(questions, { answers, notes = {} }) {
  const result = {};
  questions.forEach((question, index) => {
    const values = answers[`q${index}`];
    const chosen =
      !question.multiSelect && values?.length === 1
        ? (question.options || []).find((option) => option.label === values[0])
        : null;
    const preview =
      typeof chosen?.preview === "string" &&
      chosen.preview.trim() &&
      chosen.preview.length <= nativePreviewLimit
        ? chosen.preview
        : null;
    const note = notes[`q${index}`]?.trim();
    if (preview || note)
      result[question.question] = {
        ...(preview ? { preview } : {}),
        ...(note ? { notes: note } : {}),
      };
  });
  return Object.keys(result).length ? result : null;
}
