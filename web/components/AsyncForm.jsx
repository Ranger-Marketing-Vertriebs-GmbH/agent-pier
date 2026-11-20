import { commonCopy } from "../lib/i18n/messages/common.js";
import useAsyncAction from "../lib/useAsyncAction.js";
import React, { useEffect } from "react";
import ErrorMessage from "./ErrorMessage.jsx";
export default function AsyncForm({
  children,
  submit,
  button,
  close,
  danger = false,
  disabled = false,
  // A new value clears the shown error: the caller resolved what it said.
  resetError,
}) {
  const { busy, error, run, clear } = useAsyncAction();
  useEffect(() => {
    if (resetError) clear();
    // clear is a new function each render; only a new resetError clears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetError]);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        await run(() => submit(data));
      }}
    >
      <div className="form-content">
        {children}
        <ErrorMessage error={error} />
      </div>
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={close}>
          {commonCopy.cancel}
        </button>
        <button
          className={`button ${danger ? "danger" : "primary"}`}
          disabled={busy || disabled}
        >
          {busy ? commonCopy.pending : button}
        </button>
      </div>
    </form>
  );
}
