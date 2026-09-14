import {
  editorReducer,
  emptyEditorState,
  requiresEditorRetention,
} from "./file-editor-state.js";
import { serializeDocument } from "./file-text-format.js";
import { fileClientIssue } from "./file-api.js";
import { requestId } from "./file-action-utils.js";
import { browserUuid } from "../../lib/browser-uuid.js";

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
  const validDocument = (document, path) =>
    document &&
    document.path === path &&
    typeof document.text === "string" &&
    /^d1:[a-f0-9]{64}$/.test(document.revision) &&
    /^e1:[a-f0-9]{64}$/.test(document.metadataRevision);
  const validMetadata = (metadata, path) =>
    metadata &&
    metadata.path === path &&
    typeof metadata.resolvedPath === "string" &&
    /^e1:[a-f0-9]{64}$/.test(metadata.metadataRevision);
  const sameVersion = (current, captured) =>
    current &&
    current.id === captured.id &&
    current.client === captured.client &&
    current.scopeId === captured.scopeId &&
    current.path === captured.path &&
    current.baselineGeneration === captured.baselineGeneration &&
    current.text === captured.text &&
    current.format?.bom === captured.format?.bom &&
    current.format?.lineEnding === captured.format?.lineEnding &&
    current.attempt === captured.attempt;
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
        id: browserUuid(),
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
        if (!validDocument(document, path))
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
    replace: (id, revision) => save(id, null, revision),
    async observe(id, signal) {
      const captured = find(id);
      if (!captured?.document) return { status: "obsolete" };
      try {
        const metadata = await captured.client.documentMetadata(captured.path, signal);
        const current = find(id);
        if (!sameVersion(current, captured)) return { status: "obsolete" };
        if (!validMetadata(metadata, captured.path))
          throw fileClientIssue("FILE_INVALID_RESPONSE", 200);
        if (metadata.metadataRevision === current.document.metadataRevision) {
          patch(id, { external: null });
          return { status: "unchanged" };
        }
        patch(id, { external: metadata });
        return { status: "changed", metadata };
      } catch (error) {
        if (!sameVersion(find(id), captured) || signal?.aborted)
          return { status: "obsolete", error };
        patch(id, { external: { error } });
        return { status: "failed", error };
      }
    },
    async reload(id, signal) {
      const captured = find(id);
      if (!captured?.document || requiresEditorRetention(captured) || !captured.external)
        return { status: "obsolete" };
      try {
        const document = await captured.client.readText(captured.path, signal);
        if (!sameVersion(find(id), captured) || signal?.aborted)
          return { status: "obsolete" };
        if (!validDocument(document, captured.path))
          throw fileClientIssue("FILE_INVALID_RESPONSE", 200);
        dispatch({ type: "reloaded", id, document });
        return { status: "reloaded" };
      } catch (error) {
        if (!sameVersion(find(id), captured) || signal?.aborted)
          return { status: "obsolete", error };
        patch(id, { external: { ...captured.external, error } });
        return { status: "failed", error };
      }
    },
    async inspectConflict(id, signal) {
      const captured = find(id);
      if (captured?.error?.code !== "FILE_CONFLICT_CHANGED")
        return { status: "not-conflict" };
      try {
        const document = await captured.client.readText(captured.path, signal);
        if (!sameVersion(find(id), captured) || signal?.aborted)
          return { status: "obsolete" };
        if (!validDocument(document, captured.path))
          throw fileClientIssue("FILE_INVALID_RESPONSE", 200);
        const conflict = { document, baselineGeneration: captured.baselineGeneration };
        patch(id, { conflict });
        return { status: "conflict", conflict };
      } catch (error) {
        if (!sameVersion(find(id), captured) || signal?.aborted)
          return { status: "obsolete", error };
        patch(id, { conflict: { error } });
        return { status: "failed", error };
      }
    },
    useCurrent(id) {
      const tab = find(id);
      if (!validDocument(tab?.conflict?.document, tab?.path))
        return { status: "obsolete" };
      dispatch({ type: "reloaded", id, document: tab.conflict.document });
      return { status: "reloaded" };
    },
    dismissConflict(id) {
      const tab = find(id);
      if (!validDocument(tab?.conflict?.document, tab?.path))
        return { status: "obsolete" };
      dispatch({ type: "resolve-conflict", id, document: tab.conflict.document });
      return { status: "resolving" };
    },
  };
  function save(id, as = null, replacementRevision = null) {
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
    const revision = as
      ? (as.revision ?? null)
      : replacementRevision || tab.document.revision;
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
    patch(id, {
      attempt,
      pending: true,
      error: null,
      outcome: null,
      conflict: null,
    });
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
