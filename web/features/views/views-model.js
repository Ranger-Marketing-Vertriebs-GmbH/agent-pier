// The client's copy of the views document (`GET /api/views`, live topic `views`):
// `{ epoch, version, views }`. A live frame never replaces a newer document of the
// same epoch (a read that started before a write may arrive after its answer); one of
// another epoch (the server started again, say after a restore) replaces it whatever
// its version. A write's answer is trusted.
//
// Before the first read the client only knows what its writes answered (opening a view
// marks it used at once): that document stays `unread` at version 0, so the first read
// replaces it even when it is older than those answers.

/** The document before anything was read. */
export const unreadViews = Object.freeze({ version: 0, views: [], unread: true });

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The views document of `data`; anything without a `views` list is empty. */
export function normalizeViews(data) {
  if (!isRecord(data) || !Array.isArray(data.views)) return { version: 0, views: [] };
  return {
    ...epochOf(data),
    version: Number.isSafeInteger(data.version) && data.version >= 0 ? data.version : 0,
    views: data.views.filter((view) => isRecord(view) && typeof view.id === "string"),
  };
}

const epochOf = (value) =>
  typeof value?.epoch === "string" ? { epoch: value.epoch } : {};

/** `incoming` when `current` is unread, of another epoch or not newer. */
export const adoptViews = (current, incoming) =>
  current.unread ||
  incoming.epoch !== current.epoch ||
  incoming.version >= current.version
    ? incoming
    : current;

/** The document after a write's answer `{ version, view?, removedId? }`. */
export function withWrite(current, { epoch, version, view, removedId }) {
  let views = current.views;
  if (removedId) views = views.filter((item) => item.id !== removedId);
  if (view)
    views = views.some((item) => item.id === view.id)
      ? views.map((item) => (item.id === view.id ? view : item))
      : [...views, view];
  if (current.unread) return { ...current, views };
  return { ...epochOf(typeof epoch === "string" ? { epoch } : current), version, views };
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
