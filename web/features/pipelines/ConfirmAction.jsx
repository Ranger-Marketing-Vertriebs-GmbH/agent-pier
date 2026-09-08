import React from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
export default function ConfirmAction({
  description,
  action,
  close,
  label = commonCopy.remove,
}) {
  const mutation = useAsyncAction();
  return (
    <Modal
      title={copy.confirmAction}
      close={() => {
        if (!mutation.lock.current) close();
      }}
      closeDisabled={mutation.busy}
    >
      <div className="pipeline-form">
        <p>{description}</p>
        <ErrorMessage error={mutation.error} />
        <div className="pipeline-actions">
          <button className="button secondary" disabled={mutation.busy} onClick={close}>
            {commonCopy.cancel}
          </button>
          <button
            className="button danger"
            disabled={mutation.busy}
            onClick={() => mutation.run(action)}
          >
            {label}
          </button>
        </div>
      </div>
    </Modal>
  );
}
