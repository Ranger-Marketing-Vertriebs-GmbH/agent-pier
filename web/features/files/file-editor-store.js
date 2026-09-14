import {
  editorReducer,
  emptyEditorState,
  requiresEditorRetention,
} from "./file-editor-state.js";
import { serializeDocument } from "./file-text-format.js";
import { fileClientIssue } from "./file-api.js";
import { requestId } from "./file-action-utils.js";

export function createFileEditorStore() {
  let state = emptyEditorState();
  const listeners = new Set();
  const inflight = new Map();
  const dispatch = (action) => {
    state = editorReducer(state, action);
    listeners.forEach((listener) => listener());
  };
  const find = (id) => state.tabs.find((tab) => tab.id === id);
  const patch = (id, value) => dispatch({ type: "patch", id, patch: value });
  const fail = (id, error) => {
    const outcome = { status: "failed", error };
    patch(id, { error, outcome, pending: false });
    return outcome;
  };
  const store = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async open(client, scopeId, path, limits = {}, scope = {}) {
      const existing = state.tabs.find(
        (tab) => tab.scopeId === scopeId && tab.path === path,
      );
      if (existing?.document || existing?.loading) {
        store.activate(existing.id);
        return existing;
      }
      if (existing) dispatch({ type: "close", id: existing.id });
      const tab = {
        id: crypto.randomUUID(),
        client,
        scopeId,
        path,
        limits,
        scope: { ...scope },
        loading: true,
        text: "",
        dirty: false,
        editorState: null,
        scrollTop: 0,
        baselineGeneration: 0,
      };
      dispatch({ type: "open", tab });
      try {
        const document = await client.readText(path);
        if (
          !document ||
          typeof document.text !== "string" ||
          !/^d1:[a-f0-9]{64}$/.test(document.revision) ||
          !/^e1:[a-f0-9]{64}$/.test(document.metadataRevision) ||
          document.path !== path
        )
          throw fileClientIssue("FILE_INVALID_RESPONSE", 200);
        dispatch({ type: "loaded", id: tab.id, document });
      } catch (error) {
        patch(tab.id, { error, loading: false });
      }
      return find(tab.id) ?? tab;
    },
    activate: (id) => dispatch({ type: "activate", id }),
    edit: (id, value) => dispatch({ type: "edit", id, patch: value }),
    format: (id, value) => dispatch({ type: "format", id, patch: value }),
    close(id, { discard = false } = {}) {
      const tab = find(id);
      if (requiresEditorRetention(tab) && !discard) {
        const outcome = {
          status: tab.pending
            ? "close-pending"
            : tab.attempt
              ? "close-unresolved"
              : "dirty",
        };
        patch(id, { outcome });
        return outcome;
      }
      dispatch({ type: "close", id });
      return { status: "closed" };
    },
    save: (id) => save(id),
    saveAs: (id, path, options = {}) => save(id, { path, ...options }),
  };
  function save(id, as = null) {
    const tab = find(id);
    if (!tab?.document) return Promise.resolve({ status: "closed" });
    if (inflight.has(id)) return inflight.get(id);
    if (!as && tab.document.readOnly)
      return Promise.resolve(fail(id, fileClientIssue("FILE_READ_ONLY", 409)));
    let bytes;
    try {
      bytes = serializeDocument({ ...tab.document, ...tab.format }, tab.text);
      if (bytes.length > (tab.limits.textBytes ?? 2 * 1024 * 1024))
        throw fileClientIssue("FILE_LIMIT_EXCEEDED", 413);
      if (
        as &&
        (!as.path ||
          as.path === tab.path ||
          (as.revision !== undefined &&
            as.revision !== null &&
            (!as.replaceConfirmed || !/^d1:[a-f0-9]{64}$/.test(as.revision))))
      )
        throw fileClientIssue("FILE_TEXT_PRECONDITION", 400);
    } catch (error) {
      return Promise.resolve(fail(id, error));
    }
    const path = as?.path ?? tab.path;
    const revision = as ? (as.revision ?? null) : tab.document.revision;
    const previous = tab.attempt;
    const reusable =
      previous &&
      previous.path === path &&
      previous.revision === revision &&
      previous.baselineGeneration === tab.baselineGeneration &&
      previous.bytes.length === bytes.length &&
      previous.bytes.every((byte, index) => byte === bytes[index]);
    const attempt = reusable
      ? previous
      : {
          requestId: requestId(),
          path,
          revision,
          bytes: new Uint8Array(bytes),
          text: tab.text,
          format: { ...tab.format },
          baselineGeneration: tab.baselineGeneration,
          scopeId: tab.scopeId,
          client: tab.client,
          saveAs: Boolean(as),
        };
    patch(id, { attempt, pending: true, error: null, outcome: null });
    const operation = (async () => {
      try {
        const result = await attempt.client.saveText(
          attempt.path,
          new Uint8Array(attempt.bytes),
          {
            scopeId: attempt.scopeId,
            requestId: attempt.requestId,
            revision: attempt.revision,
          },
        );
        if (
          result.path !== attempt.path ||
          !/^d1:[a-f0-9]{64}$/.test(result.revision) ||
          !/^e1:[a-f0-9]{64}$/.test(result.metadataRevision)
        )
          throw fileClientIssue("FILE_INVALID_RESPONSE", 200);
        const current = find(id);
        if (
          !current ||
          current.attempt !== attempt ||
          current.baselineGeneration !== attempt.baselineGeneration
        )
          return { status: "obsolete" };
        if (attempt.saveAs) {
          const outcome = { status: "saved-as", path: attempt.path, result };
          patch(id, { pending: false, attempt: null, error: null, outcome });
          return outcome;
        }
        dispatch({ type: "saved", id, attempt, result });
        return find(id).outcome;
      } catch (error) {
        if (find(id)?.attempt !== attempt) return { status: "obsolete", error };
        return fail(id, error);
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, operation);
    return operation;
  }
  return store;
}
