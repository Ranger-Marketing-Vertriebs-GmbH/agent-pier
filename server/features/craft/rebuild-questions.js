// The open questions and approvals of rebuilds that wait for the owner: what the inbox
// lists (type `craft`) and what a push announces once (kind `craft-question`,
// craft-rebuilds-wiring.js). Each is addressed as `<rebuildId>:<questionId>`.

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const questionId = "[A-Za-z0-9][A-Za-z0-9_.-]{0,79}";

// Rebuild ids are randomUUID() (craft-rebuilds.js).
export const REBUILD_ID = new RegExp(`^${uuid}$`);
/** A rebuild question's address: `<rebuildId>:<questionId>`. */
export const CRAFT_QUESTION_KEY = new RegExp(`^${uuid}:${questionId}$`);

export const questionKey = (rebuildId, id) => `${rebuildId}:${id}`;

/**
 * The questions of a RebuildView the owner answers: in auto mode the supervisor allows
 * approvals itself, so only its questions remain. A question whose id cannot be
 * addressed is left to the rebuild's own page.
 */
export function ownerQuestions(view) {
  if (!view || !Array.isArray(view.questions)) return [];
  return view.questions.filter(
    (question) =>
      !(view.autoMode && question.kind === "approval") &&
      CRAFT_QUESTION_KEY.test(questionKey(view.id, question.id)),
  );
}

/** The notice of a newly open question for NotificationService#notify. */
export function questionNotice(view, question) {
  const key = questionKey(view.id, question.id);
  return {
    kind: "craft-question",
    eventId: key,
    rebuildId: view.id,
    // The rebuild's name is its project folder's.
    ...(view.name ? { label: view.name } : {}),
    // An approval names what it would run; only a question previews itself.
    ...(question.kind === "question" && question.title
      ? { preview: question.title }
      : {}),
    inbox: { type: "craft", id: key },
  };
}
