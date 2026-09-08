import BackupContents from "./BackupContents.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmOperation from "./ConfirmOperation.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
async function uploadArchive(file) {
  const response = await fetch("/api/operations/restore/upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result.archiveId;
}
export default function RestoreForm({ close, started }) {
  const [file, setFile] = useState(null),
    [archiveId, setArchiveId] = useState(""),
    [inspection, setInspection] = useState(null),
    [targetDataDir, setTarget] = useState(""),
    [projectMap, setMap] = useState({}),
    [passphrase, setPassphrase] = useState(""),
    [confirm, setConfirm] = useState(false);
  const action = useAsyncAction(),
    dismiss = () => {
      if (!action.lock.current && !confirm) close();
    };
  return (
    <Modal
      title={copy.inspectArchive}
      close={dismiss}
      closeDisabled={action.busy || confirm}
      wide
    >
      <form
        className="operations-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (inspection) {
            setConfirm(true);
            return;
          }
          action.run(async () => {
            const id = archiveId || (await uploadArchive(file));
            setArchiveId(id);
            const result = await api("/operations/restore/inspect", "POST", {
              archiveId: id,
              ...(passphrase ? { passphrase } : {}),
            });
            setInspection(result.inspection);
          });
        }}
      >
        <fieldset disabled={action.busy}>
          <label>
            {copy.archive}
            <input
              type="file"
              required
              onChange={(event) => {
                setFile(event.target.files[0] || null);
                setArchiveId("");
                setInspection(null);
                setMap({});
                setPassphrase("");
              }}
            />
          </label>
          {inspection && (
            <>
              <p className="field-description">{copy.restoreHelp}</p>
              <h3>{copy.omissions}</h3>
              <BackupContents values={inspection.omissions} />
              <label>
                {copy.targetDataDir}
                <input
                  required
                  value={targetDataDir}
                  onChange={(event) => setTarget(event.target.value)}
                />
              </label>
              {inspection.projects.length > 0 && <h3>{copy.projectMapping}</h3>}
              {inspection.projects.map((project) => (
                <label key={project.id}>
                  {project.name}
                  <input
                    required
                    aria-label={project.name}
                    value={projectMap[project.id] || ""}
                    placeholder={project.cwd}
                    onChange={(event) =>
                      setMap((current) => ({
                        ...current,
                        [project.id]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              {inspection.requiresPassphrase && (
                <label>
                  {copy.passphrase}
                  <input
                    required
                    type="password"
                    value={passphrase}
                    autoComplete="off"
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </label>
              )}
            </>
          )}
        </fieldset>
        <ErrorMessage error={action.error} />
        <div className="operations-actions">
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={dismiss}
          >
            {copy.cancel}
          </button>
          <button className="button primary" disabled={action.busy || !file}>
            {inspection ? copy.restore : copy.inspect}
          </button>
        </div>
      </form>
      {confirm && (
        <ConfirmOperation
          description={`${copy.restoreConfirmation} ${targetDataDir}`}
          close={() => setConfirm(false)}
          action={async () => {
            const result = await api("/operations/restore", "POST", {
              archiveId,
              targetDataDir,
              projectMap,
              ...(passphrase ? { passphrase } : {}),
            });
            setPassphrase("");
            started(result.job);
          }}
        />
      )}
    </Modal>
  );
}
