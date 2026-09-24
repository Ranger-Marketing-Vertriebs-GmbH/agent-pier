import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import CloneForm from "../repositories/CloneForm.jsx";

// The draft belongs to the page, so closing the dialog keeps it. A pending clone
// restores its request after the page itself was left and opened again.
export function useCloneDraft({ operation, defaultDirectory, credentials, loading }) {
  const previousRequest = operation.request;
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
    if (loading) return;
    if (credentialId && !credentials.some((item) => item.id === credentialId))
      setCredentialId("");
  }, [credentials, credentialId, loading]);
  return {
    credentialId,
    setCredentialId,
    url,
    setUrl,
    parentDirectory,
    setParentDirectory,
    folderName,
    setFolderName,
    parentEdited,
  };
}

export default function CloneDialog({ draft, operation, credentials, reload, close }) {
  return (
    <Modal
      title={commonCopy.cloneRepository}
      close={close}
      className="project-dialog clone-dialog"
    >
      <CloneForm
        {...draft}
        cloning={operation.cloning}
        cloneError={operation.error}
        credentials={credentials}
        reload={reload}
        cancel={close}
      />
    </Modal>
  );
}
