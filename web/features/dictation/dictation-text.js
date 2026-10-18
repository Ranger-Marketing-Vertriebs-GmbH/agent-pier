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

function rebase(draft, current) {
  let text = current;
  if (draft.interim && current.endsWith(draft.interim)) {
    text = current.slice(0, -draft.interim.length);
    // Only the space join() put before it; a line break stays.
    if (text.endsWith(" ")) text = text.slice(0, -1);
  }
  return { base: text, finals: "", interim: "", written: current };
}

/** Applies one `{final, text}` transcript to the composer's `current` text. */
export function applyTranscript(draft, current, { final, text }) {
  // The owner typed meanwhile: keep their text and continue after it. An interim
  // phrase still at its end is the dictation's own and gets replaced, not repeated.
  const base = current === draft.written ? draft : rebase(draft, current);
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
