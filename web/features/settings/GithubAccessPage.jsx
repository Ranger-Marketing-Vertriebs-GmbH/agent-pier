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
import { usePageAction } from "../../app/page-action.js";
/**
 * Zugänge › GitHub-Zugänge: token profiles with check, edit and delete. `only` shows
 * one profile (its full view) with `after(credential)` below it; `rowExtra` adds an
 * action per row; `onChanged` hears saves and deletes (`deletedId` when one went).
 */
export default function GithubAccessPage({
  only,
  after,
  rowExtra,
  onChanged,
  emptyState,
} = {}) {
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
  // ⌘K "GitHub-Zugang hinzufügen" opens the add dialog once the list has loaded.
  usePageAction(
    "github-add",
    () => setModal({}),
    !only && !loading && !loadError && !cloning,
  );
  return (
    <div className="page github-access-page">
      <header className="page-heading">
        <div>
          <p>{repositoriesPageCopy.agentCredentialDescription}</p>
        </div>
        {/* An empty list offers adding in its empty state; a full view shows one entry. */}
        {!only && !(emptyState && !loading && !loadError && !credentials.length) && (
          <button
            className="button primary"
            disabled={loading || Boolean(loadError) || cloning}
            onClick={() => setModal({})}
          >
            <Icon name="plus" />
            {commonCopy.addToken}
          </button>
        )}
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
      {!loading && !loadError && !credentials.length && emptyState
        ? emptyState(() => setModal({}))
        : null}
      {!loading && !loadError && (credentials.length > 0 || !emptyState) && (
        <>
          <CredentialList
            credentials={
              only ? credentials.filter((item) => item.id === only) : credentials
            }
            extra={rowExtra}
            cloning={cloning}
            setModal={setModal}
            label={copy.pageHeadingTitle}
            checked={(credential) =>
              setCredentials((items) =>
                items.map((item) => (item.id === credential.id ? credential : item)),
              )
            }
          />
          {only &&
            credentials
              .filter((item) => item.id === only)
              .map((credential) => (
                <React.Fragment key={credential.id}>{after?.(credential)}</React.Fragment>
              ))}
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
            onChanged?.(credential, deletedId);
          }}
        />
      )}
    </div>
  );
}
