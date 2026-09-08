import { commonCopy } from "../lib/i18n/messages/common.js";
import React, { useEffect, useRef, useId } from "react";
import Icon from "./Icon.jsx";
export default function Modal({
  title,
  children,
  close,
  wide = false,
  className = "",
  closeDisabled = false,
  dismissOnBackdrop = true,
  closeIcon,
}) {
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
      className={[wide ? "wide" : "", className].filter(Boolean).join(" ")}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            close();
        }
      }}
      aria-labelledby={titleId}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label={commonCopy.closeDialog}
          disabled={closeDisabled}
          onClick={close}
        >
          {closeIcon ?? <Icon name="close" />}
        </button>
      </div>
      {children}
    </dialog>
  );
}
