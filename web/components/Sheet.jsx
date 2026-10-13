import React, { useEffect, useId, useRef } from "react";

function SheetDialog({ title, onCancel, className = "", children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
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

// A bottom sheet on phones and a centred dialog (max 420px) on desktop.
export default function Sheet({ open, ...props }) {
  return open ? <SheetDialog {...props} /> : null;
}
