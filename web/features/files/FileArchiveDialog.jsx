import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { operation, bytes } from "./file-action-utils.js";

export const archiveActions = [
  "archive",
  "download_zip",
  "download_folder",
  "extract_here",
  "extract_to",
];
export const canExtract = (items) =>
  items.length === 1 &&
  items[0].type === "file" &&
  /\.zip$/i.test(items[0].name || items[0].path);

export default function FileArchiveDialog({ selection, folder, jobs, kind, onClose }) {
  const extract = kind.startsWith("extract_"),
    download = kind.startsWith("download_");
  const [target, setTarget] = useState(folder.path);
  const [name, setName] = useState("archive.zip");
  const [pending, setPending] = useState(false),
    [error, setError] = useState(null);
  const attempt = useRef(null),
    busy = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const selected =
    kind === "download_folder" || !selection.length ? [{ path: folder.path }] : selection;
  const allowed = !folder.readOnly || download;
  const submit = async (event) => {
    event.preventDefault();
    if (busy.current || !allowed) return;
    if (!attempt.current)
      attempt.current = extract
        ? operation(
            "extract",
            selected.map((item) => item.path),
            target,
          )
        : operation(
            "archive",
            selected.map((item) => item.path),
            download ? null : target,
            download ? null : name,
            { output: download ? "download" : "file" },
          );
    if (bytes(attempt.current) > 64 * 1024) {
      setError({ message: copy.errors.FILE_LIMIT_EXCEEDED });
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await jobs.start(folder.scopeId, attempt.current);
      if (alive.current) onClose(true);
    } catch (issue) {
      if (alive.current) setError(issue);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <Modal
      className="file-action-dialog"
      title={copy.transfers.actions[kind]}
      close={() => {
        if (!pending) onClose();
      }}
      closeDisabled={pending}
    >
      <form onSubmit={submit}>
        <p>{extract ? copy.transfers.extractPolicy : copy.transfers.archivePolicy}</p>
        <ul className="file-frozen-selection">
          {selected.map((item) => (
            <li key={item.path}>{item.path}</li>
          ))}
        </ul>
        {!download && (
          <label>
            {copy.transfers.target}
            <input
              name="target"
              value={target}
              required={folder.kind === "global"}
              readOnly={kind === "extract_here"}
              disabled={pending || Boolean(attempt.current)}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
        )}
        {!extract && !download && (
          <label>
            {copy.name}
            <input
              name="name"
              value={name}
              required
              disabled={pending || Boolean(attempt.current)}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <ErrorMessage error={error?.message} />
        {attempt.current && error && <p>{copy.transfers.sameAttempt}</p>}
        <div className="file-action-buttons">
          <button className="button" disabled={pending || !allowed}>
            {copy.actions.confirm}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={pending}
            onClick={() => onClose()}
          >
            {copy.actions.choices.cancel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
