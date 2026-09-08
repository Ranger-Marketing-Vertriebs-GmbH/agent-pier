import { commonCopy } from "../../lib/i18n/de/common.js";
import { cloneFormCopy as copy } from "../../lib/i18n/de/repositories.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import Icon from "../../components/Icon.jsx";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
import { cloneRepository } from "./cloneStore.js";
import RepositoryPicker from "./RepositoryPicker.jsx";
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
  notice,
}) {
  const [browse, setBrowse] = useState(false);
  return (
    <section
      className="repository-section repository-clone"
      aria-labelledby="repository-clone-title"
    >
      <h2 id="repository-clone-title">{copy.repositoryCloneTitle}</h2>
      <p className="field-description">{copy.cloneDescription}</p>
      <form
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
        <fieldset
          className="repository-fields repository-clone-fields"
          disabled={cloning}
        >
          <label>
            {copy.credentialLabel}
            <select
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
            >
              <option value="">{copy.repositoryFieldsOption}</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.host}
                </option>
              ))}
            </select>
          </label>
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
          <label>
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
        {notice && (
          <p className="repository-notice" role="status">
            {notice}
          </p>
        )}
        <div className="repository-clone-actions">
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
    </section>
  );
}
