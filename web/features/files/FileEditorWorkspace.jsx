import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { fileClientIssue } from "./file-api.js";
import useFileEditor from "./useFileEditor.js";
import FileEditorTabs from "./FileEditorTabs.jsx";
import { requestFileNavigation } from "./file-navigation-guard.js";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";
const FileEditor = lazy(() => import("./FileEditor.jsx"));
const FileEditorConflict = lazy(() => import("./FileEditorConflict.jsx"));

export default function FileEditorWorkspace({ client, context, path, canOpen }) {
  const editor = useFileEditor({
    client,
    scopeId: context?.scopeId,
    limits: context?.limits,
    scope: { kind: context?.kind, root: context?.root },
  });
  const observe = editor.observe;
  const invalidateObservation = editor.invalidateObservation;
  const inspectConflict = editor.inspectConflict;
  const tab = editor.tabs.find((item) => item.id === editor.activeId);
  const searchRef = useRef(null);
  const [destination, setDestination] = useState("");
  const [replacement, setReplacement] = useState(null);
  const [targetError, setTargetError] = useState(null);
  const current = Boolean(tab && context && tab.scopeId === context.scopeId);
  const targetOwner = useRef(null);
  if (
    targetOwner.current?.id !== tab?.id ||
    targetOwner.current?.destination !== destination ||
    targetOwner.current?.client !== client ||
    targetOwner.current?.scopeId !== context?.scopeId
  )
    targetOwner.current = { id: tab?.id, destination, client, scopeId: context?.scopeId };
  const save = async (id) => {
    if (!current || id !== tab?.id) return { status: "scope-changed" };
    const outcome = await editor.save(id);
    if (["saved", "updated-during-save"].includes(outcome.status)) observe(id);
    return outcome;
  };
  useEffect(() => {
    if (!current || !tab?.document) return;
    let controller = null;
    const poll = () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      observe(tab.id, controller.signal);
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    const focus = () => {
      if (!document.hidden) poll();
    };
    const visibility = () => {
      if (document.hidden) {
        controller?.abort();
        invalidateObservation(tab.id);
      } else poll();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      controller?.abort();
      invalidateObservation(tab.id);
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [current, invalidateObservation, observe, tab?.document, tab?.id]);
  useEffect(() => {
    if (
      tab?.error?.code !== "FILE_CONFLICT_CHANGED" ||
      tab.attempt?.saveAs ||
      tab.conflict
    )
      return;
    const controller = new AbortController();
    inspectConflict(tab.id, controller.signal);
    return () => controller.abort();
  }, [inspectConflict, tab?.attempt?.saveAs, tab?.conflict, tab?.error?.code, tab?.id]);
  const prepareReplacement = async () => {
    const owner = targetOwner.current;
    const request = {};
    owner.request = request;
    setReplacement(null);
    setTargetError(null);
    try {
      const document = await client.readText(destination);
      if (
        document.path !== destination ||
        !/^d1:[a-f0-9]{64}$/.test(document.revision) ||
        !/^e1:[a-f0-9]{64}$/.test(document.metadataRevision)
      )
        throw fileClientIssue("FILE_INVALID_RESPONSE", 200);
      if (document.readOnly) throw fileClientIssue("FILE_READ_ONLY", 403);
      if (targetOwner.current === owner && owner.request === request)
        setReplacement({ owner, document });
    } catch (error) {
      if (targetOwner.current === owner && owner.request === request)
        setTargetError({ owner, error });
    }
  };
  const target = replacement?.owner === targetOwner.current ? replacement : null;
  const saveAs = () =>
    current
      ? editor.saveAs(tab.id, destination)
      : editor.saveAsFresh(tab.id, destination);
  return (
    <>
      {canOpen && context && (
        <button className="button secondary" onClick={() => editor.open(path)}>
          {copy.open}
        </button>
      )}
      {editor.tabs.length > 0 && (
        <section className="file-editor" aria-label={copy.title}>
          <FileEditorTabs {...editor} />
          {tab && (
            <div
              id="file-editor-panel"
              role="tabpanel"
              aria-labelledby={`file-editor-tab-${tab.id}`}
            >
              <p className="file-editor-path">
                {tab.path} · {copy.scopeLabel(tab.scope.kind, tab.scope.root)}
              </p>
              {tab.document?.resolvedPath !== tab.path && tab.document && (
                <p className="file-editor-path">
                  {copy.resolved(tab.document.resolvedPath)}
                </p>
              )}
              {!current && <p role="status">{copy.otherScope}</p>}
              {tab.loading && <p role="status">{copy.loading}</p>}
              {tab.error && (
                <p role="alert">
                  {tab.error.message} {tab.error.code}
                </p>
              )}
              {!tab.document && (
                <button
                  onClick={() =>
                    requestFileNavigation({
                      reason: "tab-close",
                      tabId: tab.id,
                      commit: () => editor.close(tab.id, { discard: true }),
                    })
                  }
                >
                  {copy.closeTab}
                </button>
              )}
              {tab.document && (
                <>
                  {tab.document.readOnly && <p role="status">{copy.readOnly}</p>}
                  {tab.format.lineEnding === "mixed" && (
                    <p role="status">{copy.lineEndingRequired}</p>
                  )}
                  <div className="file-editor-toolbar">
                    <button
                      onClick={() => save(tab.id)}
                      disabled={
                        !current ||
                        tab.pending ||
                        tab.document.readOnly ||
                        tab.format.lineEnding === "mixed"
                      }
                    >
                      {tab.pending ? copy.saving : copy.save}
                    </button>
                    <button onClick={() => searchRef.current?.()}>{copy.search}</button>
                    <button
                      onClick={() =>
                        requestFileNavigation({
                          reason: "tab-close",
                          tabId: tab.id,
                          commit: () => editor.close(tab.id, { discard: true }),
                        })
                      }
                    >
                      {copy.closeTab}
                    </button>
                    <label>
                      {copy.lineEnding}
                      <select
                        value={tab.format.lineEnding}
                        onChange={(event) =>
                          editor.format(tab.id, { lineEnding: event.target.value })
                        }
                      >
                        <option value="mixed" disabled>
                          {copy.mixed}
                        </option>
                        <option value="lf">LF</option>
                        <option value="crlf">CRLF</option>
                      </select>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={tab.format.bom}
                        onChange={(event) =>
                          editor.format(tab.id, { bom: event.target.checked })
                        }
                      />
                      {copy.bom}
                    </label>
                  </div>
                  <Suspense fallback={<p role="status">{copy.loading}</p>}>
                    <FileEditor
                      key={`${tab.id}:${tab.reloadGeneration || 0}`}
                      tab={tab}
                      onChange={editor.edit}
                      onSave={save}
                      searchRef={searchRef}
                    />
                  </Suspense>
                  {tab.external && !tab.external.error && (
                    <p role="status">
                      {copy.externalChanged}{" "}
                      {!tab.dirty && !tab.pending && !tab.attempt && (
                        <button onClick={() => editor.reload(tab.id)}>
                          {copy.reloadCurrent}
                        </button>
                      )}
                    </p>
                  )}
                  {tab.external?.error && (
                    <p role="alert">
                      {tab.external.error.message} {tab.external.error.code}
                    </p>
                  )}
                  {tab.conflict?.document && (
                    <Suspense fallback={<p role="status">{copy.loadingConflict}</p>}>
                      <FileEditorConflict
                        draft={tab}
                        current={tab.conflict.document}
                        onUseCurrent={() => editor.useCurrent(tab.id)}
                        onResolve={() => editor.dismissConflict(tab.id)}
                        onReplace={() =>
                          editor.replace(tab.id, tab.conflict.document.revision)
                        }
                      />
                    </Suspense>
                  )}
                  {tab.conflict?.error && (
                    <p role="alert">
                      {tab.conflict.error.message} {tab.conflict.error.code}
                    </p>
                  )}
                  <form
                    className="file-editor-save-as"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveAs();
                    }}
                  >
                    <label htmlFor="file-editor-destination">{copy.destination}</label>
                    <input
                      id="file-editor-destination"
                      type="text"
                      value={destination}
                      onChange={(event) => {
                        setDestination(event.target.value);
                        setReplacement(null);
                      }}
                    />
                    <button disabled={!context || !destination || tab.pending}>
                      {copy.saveAs}
                    </button>
                    <button
                      type="button"
                      disabled={!context || !destination || tab.pending}
                      onClick={prepareReplacement}
                    >
                      {copy.inspectTarget}
                    </button>
                  </form>
                  {target && (
                    <p>
                      {copy.replaceTarget(destination)}{" "}
                      <button
                        disabled={tab.pending}
                        onClick={() =>
                          (current ? editor.saveAs : editor.saveAsFresh)(
                            tab.id,
                            destination,
                            {
                              revision: target.document.revision,
                              replaceConfirmed: true,
                            },
                          )
                        }
                      >
                        {copy.confirmReplace}
                      </button>
                    </p>
                  )}
                  {targetError?.owner === targetOwner.current && (
                    <p role="alert">{targetError.error.message}</p>
                  )}
                  {tab.outcome && (
                    <p role="status">
                      {copy.outcomes[tab.outcome.status] || ""}
                      {tab.outcome.status === "saved-as" && (
                        <>
                          {" "}
                          {tab.outcome.path}{" "}
                          <button
                            disabled={!current}
                            onClick={() => editor.open(tab.outcome.path)}
                          >
                            {copy.openSaved}
                          </button>
                        </>
                      )}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
