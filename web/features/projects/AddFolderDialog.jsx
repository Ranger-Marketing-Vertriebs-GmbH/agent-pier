import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy } from "../../lib/i18n/messages/memory.js";
import { projectDialogsCopy as copy } from "../../lib/i18n/messages/projects.js";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";

export default function AddFolderDialog({ home, close, added }) {
  const action = useAsyncAction();
  const [directory, setDirectory] = useState(home || "");
  const [browse, setBrowse] = useState(false);
  return (
    <Modal
      title={memoryCopy.addProject}
      close={close}
      closeDisabled={action.busy}
      className="project-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            const project = await api("/memory/projects", "POST", {
              cwd: directory.trim(),
            });
            added(project);
          });
        }}
      >
        <div className="form-content">
          <p className="field-description">{copy.addFolderDescription}</p>
          <label>
            {memoryCopy.directory}
            <div className="input-action">
              <input
                aria-label={memoryCopy.directory}
                required
                value={directory}
                disabled={action.busy}
                onChange={(event) => setDirectory(event.target.value)}
                spellCheck={false}
                autoCapitalize="none"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={commonCopy.chooseDirectory}
                disabled={action.busy}
                onClick={() => setBrowse(true)}
              >
                <Icon name="folder" />
              </button>
            </div>
          </label>
          <ErrorMessage error={action.error} />
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={close}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy}>
            {memoryCopy.addProject}
          </button>
        </div>
      </form>
      {browse && (
        <Modal title={memoryCopy.directory} close={() => setBrowse(false)}>
          <DirectoryPicker
            initialPath={directory || "~"}
            cancel={() => setBrowse(false)}
            choose={(path) => {
              setDirectory(path);
              setBrowse(false);
            }}
          />
        </Modal>
      )}
    </Modal>
  );
}
