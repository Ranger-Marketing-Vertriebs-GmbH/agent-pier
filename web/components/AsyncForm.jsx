import { commonCopy } from "../lib/i18n/messages/common.js";
import useAsyncAction from "../lib/useAsyncAction.js";
import React from "react";
import ErrorMessage from "./ErrorMessage.jsx";
export default function AsyncForm({
  children,
  submit,
  button,
  close,
  danger = false,
  disabled = false,
}) {
  const { busy, error, run } = useAsyncAction();
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
