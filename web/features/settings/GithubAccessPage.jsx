import { commonCopy } from "../../lib/i18n/messages/common.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import {
  repositoriesPageCopy,
  credentialDialogCopy,
  githubAccessPageCopy as copy,
} from "../../lib/i18n/messages/repositories.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import React, { useEffect, useState } from "react";
import CredentialDialog from "../repositories/CredentialDialog.jsx";
import CredentialList from "../repositories/CredentialList.jsx";
export default function GithubAccessPage() {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    api("/repositories")
      .then((data) => {
        if (!alive) return;
        setCredentials(data.credentials);
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
  return (
    <div className="page github-access-page">
      <div className="page-topline">
        <span>
          {operationsCopy.topline(
            operationsCopy.groups.access,
            operationsCopy.sections.github,
          )}
        </span>
      </div>
      <header className="page-heading">
        <div>
          <h1 id="github-access-title">{copy.pageHeadingTitle}</h1>
          <p>{repositoriesPageCopy.agentCredentialDescription}</p>
        </div>
        <button
          className="button primary"
          disabled={loading || Boolean(loadError)}
          onClick={() => setModal({})}
        >
          {commonCopy.addToken}
        </button>
      </header>
      {loading && (
        <p role="status" className="loading">
          {repositoriesPageCopy.repositoriesLoading}
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
          <CredentialList credentials={credentials} setModal={setModal} />
          <p className="field-description github-access-footnote">
            {credentialDialogCopy.multipleProfilesDescription}
          </p>
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
