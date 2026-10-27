import React, { useEffect, useRef } from "react";
import ErrorMessage from "./ErrorMessage.jsx";
import Modal from "./Modal.jsx";
import useAsyncAction from "../lib/useAsyncAction.js";
import { commonCopy } from "../lib/i18n/messages/common.js";

/**
 * The confirmation dialog (docs/ui-guide.md#confirmations). The title names the
 * object ("Delete backup 'nightly'?"), the body states the consequence, and the
 * confirm button repeats the verb. `destructive` makes it a danger button and gives
 * Cancel the initial focus, so Enter never confirms a loss; otherwise it is primary
 * (`focusCancel` also starts a risky but not destructive change on Cancel).
 * Cancel comes first and the action last; on phones the action sits on top.
 * `onConfirm` may be async: the dialog shows its busy state and error and stays open
 * until it settles. `children` adds details below the body. `confirmDisabled` keeps the
 * action off until the details are complete (a typed name for a permanent delete).
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = false,
  focusCancel = destructive,
  cancelLabel = commonCopy.cancel,
  confirmDisabled = false,
  busy: outerBusy = false,
  error: outerError = "",
  className = "",
  children,
}) {
  const mutation = useAsyncAction();
  const cancelButton = useRef(null);
  const busy = outerBusy || mutation.busy;
  useEffect(() => {
    if (focusCancel) cancelButton.current?.focus({ preventScroll: true });
  }, [focusCancel]);
  const cancel = () => {
    if (!busy && !mutation.lock.current) onCancel();
  };
  return (
    <Modal
      title={title}
      close={cancel}
      closeDisabled={busy}
      className={["confirm-dialog", className].filter(Boolean).join(" ")}
      footer={
        <>
          <button
            ref={cancelButton}
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={cancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${destructive ? "danger" : "primary"}`}
            disabled={busy || confirmDisabled}
            data-autofocus={focusCancel ? undefined : true}
            onClick={() => mutation.run(onConfirm)}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {(Array.isArray(body) ? body : [body]).filter(Boolean).map((text) => (
        <p key={text}>{text}</p>
      ))}
      {children}
      <ErrorMessage error={outerError || mutation.error} />
    </Modal>
  );
}
