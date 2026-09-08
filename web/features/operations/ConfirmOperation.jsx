import React from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { operationsCopy as copy } from "../../lib/i18n/de/operations.js";
export default function ConfirmOperation({ description, action, close }) {
  const mutation = useAsyncAction(),
    dismiss = () => {
      if (!mutation.lock.current) close();
    };
  return (
    <Modal title={copy.confirm} close={dismiss} closeDisabled={mutation.busy}>
      <div className="operations-form">
        <p>{description}</p>
        <ErrorMessage error={mutation.error} />
        <div className="operations-actions">
          <button className="button secondary" disabled={mutation.busy} onClick={dismiss}>
            {copy.cancel}
          </button>
          <button
            className="button primary"
            disabled={mutation.busy}
            onClick={() => mutation.run(action)}
          >
            {copy.confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}
