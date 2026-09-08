import { commonCopy } from "../../lib/i18n/messages/common.js";
import { repositoriesPageCopy as copy } from "../../lib/i18n/messages/repositories.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCloneOperation, subscribeToClone } from "./cloneStore.js";
import CredentialDialog from "./CredentialDialog.jsx";
import CloneForm from "./CloneForm.jsx";
import CredentialList from "./CredentialList.jsx";
export default function Repositories({ home, defaultCwd, onLaunch }) {
  const defaultDirectory = defaultCwd || home || "";
  const operation = useSyncExternalStore(subscribeToClone, getCloneOperation);
  const { cloning, error: cloneError, notice } = operation;
  const previousRequest = operation.request;
  const [credentials, setCredentials] = useState([]);
  const [savedProjects, setSavedProjects] = useState([]);
  const projects = [
    ...operation.projects,
    ...savedProjects.filter(
      (item) => !operation.projects.some((project) => project.id === item.id),
    ),
  ];
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(null);
  const [credentialId, setCredentialId] = useState(previousRequest?.credentialId || "");
  const [url, setUrl] = useState(previousRequest?.url || "");
  const [parentDirectory, setParentDirectory] = useState(
    previousRequest?.parentDirectory || defaultDirectory,
  );
  const [folderName, setFolderName] = useState(previousRequest?.folderName || "");
  const parentEdited = useRef(Boolean(previousRequest));
  useEffect(() => {
    if (!parentEdited.current) setParentDirectory(defaultDirectory);
  }, [defaultDirectory]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    api("/repositories")
      .then((data) => {
        if (!alive) return;
        setCredentials(data.credentials);
        setSavedProjects(data.projects);
      })
      .catch((error) => {
        if (alive) setLoadError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  useEffect(() => {
    if (loading) return;
    if (credentialId && !credentials.some((item) => item.id === credentialId))
      setCredentialId("");
  }, [credentials, credentialId, loading]);
  return (
    <div className="page repositories-page">
      <div className="page-topline">
        <span>{copy.pageToplineLabel}</span>
        <span className="subtle">{copy.subtle}</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{copy.pageHeadingTitle}</h1>
          <p>{copy.pageHeadingDescription}</p>
        </div>
        <button
          className="button primary"
          disabled={loading || Boolean(loadError) || cloning}
          onClick={() => setModal({})}
        >
          {commonCopy.addToken}
        </button>
      </header>
      {loading && (
        <p role="status" className="loading">
          {copy.repositoriesLoading}
        </p>
      )}
      {loadError && (
        <div className="repository-load-error">
          <ErrorMessage error={loadError} />
          <button
            className="button secondary"
            onClick={() => setReload((value) => value + 1)}
          >
            {commonCopy.retry}
          </button>
        </div>
      )}
      {!loading && !loadError && (
        <>
          <section
            aria-labelledby="repository-credentials-title"
            className="repository-section"
          >
            <div className="section-heading">
              <h2 id="repository-credentials-title">{copy.repositoryCredentialsTitle}</h2>
              <span>
                {credentials.length}
                {copy.savedCredentialsSuffix}
              </span>
            </div>
            <p className="field-description repository-agent-note">
              {copy.agentCredentialDescription}
            </p>
            <CredentialList
              {...{
                credentials,
                cloning,
                setModal,
              }}
            />
          </section>
          <CloneForm
            {...{
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
            }}
          />
          <section
            className="repository-section"
            aria-labelledby="repository-projects-title"
          >
            <div className="section-heading">
              <h2 id="repository-projects-title">{copy.repositoryProjectsTitle}</h2>
              <span>
                {projects.length}
                {copy.projectCountSuffix}
              </span>
            </div>
            <div className="repository-projects">
              {projects.length ? (
                projects.map((project) => (
                  <article className="repository-project" key={project.id}>
                    <div className="repository-details">
                      <h3>{project.name}</h3>
                      <p>{project.url}</p>
                      <code>{project.path}</code>
                    </div>
                    <button
                      className="button secondary"
                      aria-label={copy.buttonAriaLabel(project.name)}
                      onClick={() => onLaunch(project.path)}
                    >
                      {copy.launchProjectSession}
                      <span aria-hidden="true">↗</span>
                    </button>
                  </article>
                ))
              ) : (
                <p className="repository-empty">{copy.repositoryEmpty}</p>
              )}
            </div>
          </section>
        </>
      )}
      {modal && (
        <CredentialDialog
          credential={modal.credential}
          credentials={credentials}
          deleting={modal.deleting}
          close={() => setModal(null)}
          saved={(credential, deletedId) => {
            setCredentials((items) =>
              deletedId
                ? items.filter((item) => item.id !== deletedId)
                : [...items.filter((item) => item.id !== credential.id), credential],
            );
            setReload((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
