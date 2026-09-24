import { commonCopy } from "../../lib/i18n/messages/common.js";
import { cloneFormCopy as copy } from "../../lib/i18n/messages/repositories.js";
import { projectDialogsCopy } from "../../lib/i18n/messages/projects.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import Icon from "../../components/Icon.jsx";
import Segment from "../../components/Segment.jsx";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
import { cloneRepository } from "./cloneStore.js";
import RepositoryPicker from "./RepositoryPicker.jsx";
import { hostLabel } from "./hosts.js";
export default function CloneForm({
  credentialId,
  url,
  parentDirectory,
  folderName,
  setUrl,
  setFolderName,
  cloning,
  setCredentialId,
  credentials,
  reload,
  parentEdited,
  setParentDirectory,
  cloneError,
  cancel,
}) {
  const [browse, setBrowse] = useState(false);
  return (
    <>
      <form
        className="repository-clone-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const project = await cloneRepository({
            credentialId: credentialId || null,
            url: url.trim(),
            parentDirectory: parentDirectory.trim(),
            folderName: folderName.trim(),
          });
          if (project) {
            setUrl("");
            setFolderName("");
          }
        }}
      >
        <div className="form-content">
          <p className="field-description">{copy.cloneDescription}</p>
          <fieldset
            className="repository-fields repository-clone-fields"
            disabled={cloning}
          >
            <div className="repository-token-field">
              <span className="repository-field-label" aria-hidden="true">
                {copy.credentialLabel}
              </span>
              <Segment
                label={copy.credentialLabel}
                className="repository-token-segment"
                value={credentialId}
                onChange={setCredentialId}
                options={[
                  { value: "", label: projectDialogsCopy.noToken },
                  ...credentials.map((credential) => ({
                    value: credential.id,
                    label: (
                      <>
                        {credential.name}
                        <small>{hostLabel(credential.host)}</small>
                      </>
                    ),
                  })),
                ]}
              />
            </div>
            {credentialId && (
              <RepositoryPicker
                key={`${credentialId}:${reload}`}
                credentialId={credentialId}
                url={url}
                onSelect={(repository) => {
                  setUrl(repository.url);
                  setFolderName(repository.name);
                }}
              />
            )}
            <label className="repository-url-field">
              {copy.repositoryUrlLabel}
              <input
                value={url}
                required
                onChange={(event) => setUrl(event.target.value)}
                placeholder={copy.repositoryUrlPlaceholder}
                spellCheck={false}
                autoCapitalize="none"
              />
            </label>
            <label>
              {copy.parentDirectoryLabel}
              <div className="input-action">
                <input
                  aria-label={copy.parentDirectoryLabel}
                  value={parentDirectory}
                  required
                  onChange={(event) => {
                    parentEdited.current = true;
                    setParentDirectory(event.target.value);
                  }}
                  placeholder="/Pfad/zu/Projekten"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={commonCopy.chooseDirectory}
                  onClick={() => setBrowse(true)}
                >
                  <Icon name="folder" />
                </button>
              </div>
            </label>
            <label>
              {copy.folderNameLabel}
              <input
                value={folderName}
                required
                onChange={(event) => setFolderName(event.target.value)}
                placeholder={copy.folderNamePlaceholder}
                spellCheck={false}
                autoCapitalize="none"
              />
            </label>
          </fieldset>
          <ErrorMessage error={cloneError} />
          {cloning && (
            <p className="field-description">{projectDialogsCopy.cloneContinues}</p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={cancel}>
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={cloning}>
            {cloning ? commonCopy.cloning : commonCopy.cloneRepository}
          </button>
        </div>
      </form>
      {browse && (
        <Modal title={copy.parentDirectoryLabel} close={() => setBrowse(false)}>
          <DirectoryPicker
            initialPath={parentDirectory || "~"}
            cancel={() => setBrowse(false)}
            choose={(path) => {
              parentEdited.current = true;
              setParentDirectory(path);
              setBrowse(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
