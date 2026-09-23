/**
 * The draft with a cancelled or rejected message put back into the composer.
 * Only messages whose text left the composer (`released`) qualify, so nothing
 * is duplicated; attachments are merged, never dropped.
 */
export function reusedDraft(saved, id) {
  const item = saved.outbox
    ? null
    : saved.recent.find((entry) => entry.id === id && entry.released);
  if (!item) return null;
  const files = item.attachments || [];
  const lines = item.text.split("\n");
  // Attachment paths were appended to the sent text; the composer lists them.
  while (files.some((file) => file.path === lines.at(-1))) lines.pop();
  const text = lines.join("\n");
  return {
    ...saved,
    text: saved.text.trim() ? `${saved.text}\n${text}` : text,
    attachments: [
      ...saved.attachments,
      ...files.filter((file) => !saved.attachments.some((a) => a.path === file.path)),
    ].slice(0, 8),
    recent: saved.recent.filter((entry) => entry.id !== id),
  };
}
