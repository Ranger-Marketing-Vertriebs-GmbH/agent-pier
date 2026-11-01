// The client's copy of the views document (`GET /api/views`, live topic `views`):
// `{ version, views }`. A live frame never replaces a newer document (a read that
// started before a write may arrive after its answer); a write's answer is trusted.

const empty = Object.freeze({ version: 0, views: Object.freeze([]) });
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The views document of `data`; anything without a `views` list is empty. */
export function normalizeViews(data) {
  if (!isRecord(data) || !Array.isArray(data.views)) return { ...empty, views: [] };
  return {
    version: Number.isSafeInteger(data.version) && data.version >= 0 ? data.version : 0,
    views: data.views.filter((view) => isRecord(view) && typeof view.id === "string"),
  };
}

/** `incoming` when it is at least as new as `current`, else `current`. */
export const adoptViews = (current, incoming) =>
  incoming.version >= current.version ? incoming : current;

/** The document after a write's answer `{ version, view?, removedId? }`. */
export function withWrite(current, { version, view, removedId }) {
  let views = current.views;
  if (removedId) views = views.filter((item) => item.id !== removedId);
  if (view)
    views = views.some((item) => item.id === view.id)
      ? views.map((item) => (item.id === view.id ? view : item))
      : [...views, view];
  return { version, views };
}

/** The document as shown: optimistic `{ id, patch }` edits over the confirmed one. */
export function withPending(document, pending) {
  if (!pending.length) return document;
  return {
    ...document,
    views: document.views.map((view) =>
      pending.reduce(
        (current, edit) =>
          edit.id === current.id ? { ...current, ...edit.patch } : current,
        view,
      ),
    ),
  };
}
