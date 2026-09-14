import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { operation, transferOperation, references, bytes } from "./file-action-utils.js";
import "./file-actions.css";
import FileArchiveDialog, { archiveActions, canExtract } from "./FileArchiveDialog.jsx";

export default function FileActions({
  scope,
  selection,
  clipboard,
  jobs,
  onChanged,
  request,
  onRequestHandled,
}) {
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [pendingDialog, setPendingDialog] = useState(null);
  const dialogOwner = useRef(null);
  const attempt = useRef(null);
  const alive = useRef(true);
  const busy = useRef(null);
  const selected = selection.selected;
  const signature = selected.map((item) => `${item.path}\0${item.revision}`).join("\n");
  const validDialog =
    dialog &&
    (!dialog.signature || dialog.signature === signature) &&
    (!dialog.bindEntries ||
      dialog.items.every((item) =>
        selection.entries.some(
          (entry) => entry.path === item.path && entry.revision === item.revision,
        ),
      ));
  const currentDialog = validDialog ? dialog : null;
  // Invalidate during render, before a pending response or cleanup effect can run.
  if (!validDialog && dialogOwner.current === dialog) dialogOwner.current = null;
  const pending = Boolean(currentDialog && pendingDialog === currentDialog);
  const replaceDialog = (value) => {
    const restore = !value && dialogOwner.current?.restoreFocus;
    dialogOwner.current = value;
    attempt.current = null;
    setPendingDialog(null);
    setDialog(value);
    if (restore) requestAnimationFrame(() => alive.current && restore());
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      dialogOwner.current = null;
    };
  }, []);
  useEffect(() => {
    if (dialog && !validDialog)
      setDialog((current) => (current === dialog ? null : current));
  }, [dialog, validDialog]);

  const show = (kind, items = selected, extra = {}) => {
    if (
      scope.readOnly &&
      !["copy", "path", "download_zip", "download_folder"].includes(kind)
    )
      return;
    if (kind.startsWith("extract_") && !canExtract(items)) return;
    setError(null);
    setFeedback(null);
    if (kind === "copy" || kind === "cut") {
      replaceDialog(null);
      if (items.length) {
        clipboard[kind](items);
        setFeedback(kind);
      }
      requestAnimationFrame(() => alive.current && extra.restoreFocus?.());
      return;
    }
    if (kind === "path") {
      replaceDialog(null);
      const paths = items.map((item) => item.path).join("\n");
      navigator.clipboard
        .writeText(paths)
        .then(() => {
          if (alive.current) setFeedback("path");
        })
        .catch(() => {
          if (alive.current) setFeedback("copyFailed");
        })
        .finally(() =>
          requestAnimationFrame(() => alive.current && extra.restoreFocus?.()),
        );
      return;
    }
    if (kind === "paste") {
      if (!clipboard.items.length) return;
      replaceDialog({
        kind: clipboard.action === "cut" ? "move" : "copy",
        items: references(clipboard.items),
        target: scope.path,
        token: clipboard.token,
        ...extra,
      });
    } else {
      setName(kind === "rename" ? items[0]?.name || "" : "");
      replaceDialog({
        kind,
        items: archiveActions.includes(kind)
          ? items.map((item) => ({ ...item }))
          : references(items),
        bindEntries: ["rename", "trash", "move", ...archiveActions].includes(kind),
        signature: items === selected ? signature : null,
        ...extra,
      });
    }
  };
  const lastRequest = useRef(null);
  useEffect(() => {
    if (!request || request === lastRequest.current) return;
    lastRequest.current = request;
    show(request.kind, request.items || selected, {
      ...(request.target ? { target: request.target } : {}),
      ...(request.restoreFocus ? { restoreFocus: request.restoreFocus } : {}),
    });
    onRequestHandled?.();
    // Requests are explicit user gestures owned by this opened scope/path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const submit = async (event) => {
    event.preventDefault();
    if (
      !currentDialog ||
      busy.current === currentDialog ||
      dialogOwner.current !== currentDialog
    )
      return;
    const value = currentDialog;
    const owns = () => alive.current && dialogOwner.current === value;
    let body = attempt.current;
    if (!body) {
      body = ["copy", "move"].includes(value.kind)
        ? transferOperation(value.kind, value.items, value.target)
        : value.kind === "rename"
          ? operation(
              "rename",
              value.items.map((item) => item.path),
              null,
              name,
              {
                revisions: Object.fromEntries(
                  value.items.map((item) => [item.path, item.revision]),
                ),
              },
            )
          : value.kind === "trash"
            ? operation(
                "trash",
                value.items.map((item) => item.path),
              )
            : operation(value.kind, [], scope.path, name);
      attempt.current = body;
    }
    if (bytes(body) > 64 * 1024) {
      setError({ message: copy.errors.FILE_LIMIT_EXCEEDED });
      return;
    }
    busy.current = value;
    setPendingDialog(value);
    setError(null);
    try {
      const job = await jobs.start(scope.scopeId, body);
      if (value.token && value.kind === "move") clipboard.track(value.token, job.id);
      if (!owns()) return;
      replaceDialog(null);
      selection.clear();
      onChanged(value.restoreFocus);
    } catch (issue) {
      if (owns()) setError(issue);
    } finally {
      if (busy.current === value) busy.current = null;
      if (owns()) setPendingDialog(null);
    }
  };
  const titles = {
    create_file: copy.actions.newFile,
    create_directory: copy.actions.newFolder,
    rename: copy.actions.rename,
    trash: copy.actions.trash,
    copy: copy.actions.copy,
    move: copy.actions.move,
  };
  return (
    <section className="file-actions" aria-label={copy.actions.label}>
      <div className="file-action-buttons">
        <button
          className="button secondary compact"
          disabled={scope.readOnly}
          onClick={() => show("create_file")}
        >
          {copy.actions.newFile}
        </button>
        <button
          className="button secondary compact"
          disabled={scope.readOnly}
          onClick={() => show("create_directory")}
        >
          {copy.actions.newFolder}
        </button>
        <button
          className="button secondary compact"
          disabled={!selected.length}
          onClick={() => show("copy")}
        >
          {copy.actions.copy}
        </button>
        <button
          className="button secondary compact"
          disabled={scope.readOnly || !selected.length}
          onClick={() => show("cut")}
        >
          {copy.actions.cut}
        </button>
        <button
          className="button secondary compact"
          disabled={scope.readOnly || !clipboard.items.length}
          onClick={() => show("paste")}
        >
          {copy.actions.paste}
        </button>
        <button
          className="button secondary compact"
          disabled={scope.readOnly || selected.length !== 1}
          onClick={() => show("rename")}
        >
          {copy.actions.rename}
        </button>
        <button
          className="button secondary compact"
          disabled={!selected.length}
          onClick={() => show("path")}
        >
          {copy.actions.copyPath}
        </button>
        <button
          className="button secondary compact"
          disabled={scope.readOnly || !selected.length}
          onClick={() => show("trash")}
        >
          {copy.actions.trash}
        </button>
        {archiveActions.map((kind) => (
          <button
            key={kind}
            className="button secondary compact"
            disabled={
              (scope.readOnly && !kind.startsWith("download_")) ||
              (kind === "download_zip" && !selected.length) ||
              (kind.startsWith("extract_") && !canExtract(selected))
            }
            onClick={() => show(kind, kind === "download_folder" ? [] : selected)}
          >
            {copy.transfers.actions[kind]}
          </button>
        ))}
        {selected.length > 0 && (
          <button className="button secondary compact" onClick={selection.clear}>
            {copy.actions.clearSelection}
          </button>
        )}
      </div>
      <p className="field-description">
        {copy.actions.selection(selected.length)}{" "}
        {clipboard.items.length > 0 &&
          copy.actions.clipboard(clipboard.items.length, copy.actions[clipboard.action])}
      </p>
      {feedback && (
        <p role="status">
          {feedback === "copyFailed"
            ? copy.copyFailed
            : feedback === "path"
              ? copy.copied
              : copy.actions.clipboardReady}
        </p>
      )}
      {currentDialog && archiveActions.includes(currentDialog.kind) && (
        <FileArchiveDialog
          key={currentDialog.kind}
          selection={currentDialog.items}
          folder={scope}
          jobs={jobs}
          kind={currentDialog.kind}
          onClose={(started) => {
            if (dialogOwner.current !== currentDialog) return;
            replaceDialog(null);
            if (started) onChanged();
          }}
        />
      )}
      {currentDialog && !archiveActions.includes(currentDialog.kind) && (
        <Modal
          className="file-action-dialog"
          title={titles[currentDialog.kind]}
          close={() => {
            if (!pending) replaceDialog(null);
          }}
          closeDisabled={pending}
        >
          <form onSubmit={submit}>
            {["create_file", "create_directory", "rename"].includes(
              currentDialog.kind,
            ) && (
              <label>
                {copy.name}
                <input
                  name="name"
                  value={name}
                  required
                  autoFocus
                  disabled={pending || Boolean(attempt.current)}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {currentDialog.kind === "trash" && <p>{copy.actions.trashConfirm}</p>}
            {["copy", "move"].includes(currentDialog.kind) && (
              <p>{copy.actions.destination(currentDialog.target)}</p>
            )}
            <ul className="file-frozen-selection">
              {currentDialog.items.map((item) => (
                <li key={item.path}>{item.path}</li>
              ))}
            </ul>
            <ErrorMessage error={error?.message} />
            <div className="file-action-buttons">
              <button className="button" disabled={pending || scope.readOnly}>
                {copy.actions.confirm}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => replaceDialog(null)}
              >
                {copy.actions.choices.cancel}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
