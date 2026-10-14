import React, { useId } from "react";
import useModalDialog from "./useModalDialog.js";

function SheetDialog({ title, onCancel, className = "", children }) {
  const ref = useModalDialog();
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={["sheet", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="sheet-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

// A bottom sheet with a grab handle on phones and a centred dialog (max 420px) on
// desktop.
export default function Sheet({ open, ...props }) {
  return open ? <SheetDialog {...props} /> : null;
}
