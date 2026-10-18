// How live transcripts enter the composer: final segments accumulate after the text
// that was there, and the current interim segment follows them until the next
// result replaces it. An edit in the field during dictation becomes the new start.

const join = (left, right) =>
  !left ? right : !right ? left : /\s$/.test(left) ? left + right : `${left} ${right}`;

export function startDraft(text) {
  return { base: text, finals: "", interim: "", written: text };
}

/** The field's text for `draft`. */
export const draftText = (draft) => join(join(draft.base, draft.finals), draft.interim);

/** Applies one `{final, text}` transcript to the composer's `current` text. */
export function applyTranscript(draft, current, { final, text }) {
  // The owner typed meanwhile: keep their text and continue after it.
  const base =
    current === draft.written
      ? draft
      : { base: current, finals: "", interim: "", written: current };
  const next = final
    ? { ...base, finals: join(base.finals, text), interim: "" }
    : { ...base, interim: text };
  return { ...next, written: draftText(next) };
}

/** The end of a dictation keeps an interim segment no final result replaced. */
export function settleDraft(draft, current) {
  if (current !== draft.written || !draft.interim) return draft;
  return applyTranscript(draft, current, { final: true, text: draft.interim });
}

/** Whether the dictation added any words. */
export const dictated = (draft) => Boolean(draft.finals || draft.interim);
