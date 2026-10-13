import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  repositoriesPageCopy,
  credentialDialogCopy,
  githubAccessPageCopy as copy,
} from "../../lib/i18n/messages/repositories.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import CredentialDialog from "../repositories/CredentialDialog.jsx";
import CredentialList from "../repositories/CredentialList.jsx";
import { getCloneOperation, subscribeToClone } from "../repositories/cloneStore.js";
export default function GithubAccessPage() {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(null);
  // A clone keeps running after its dialog closes and uses a token, so token changes
  // wait until it has finished.
  const { cloning } = useSyncExternalStore(subscribeToClone, getCloneOperation);
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
      <header className="page-heading">
        <div>
          <p>{repositoriesPageCopy.agentCredentialDescription}</p>
        </div>
        <button
          className="button primary"
          disabled={loading || Boolean(loadError) || cloning}
          onClick={() => setModal({})}
        >
          <Icon name="plus" />
          {commonCopy.addToken}
        </button>
      </header>
      {loading && (
        <p role="status" className="loading">
          {copy.loading}
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
          <CredentialList
            credentials={credentials}
            cloning={cloning}
            setModal={setModal}
            label={copy.pageHeadingTitle}
          />
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
