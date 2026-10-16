// The chat note where OpenClaw summarised earlier messages (conversations.js), with
// its token counts rounded to thousands when both are known.
const thousands = (n) => Math.max(1, Math.round(n / 1000));
export function compactionNoteText(copy, note) {
  const { tokensBefore, tokensAfter } = note || {};
  if (!Number.isFinite(tokensBefore) || !Number.isFinite(tokensAfter))
    return copy.compaction.noteWithoutTokens;
  return copy.compaction.note(thousands(tokensBefore), thousands(tokensAfter));
}
