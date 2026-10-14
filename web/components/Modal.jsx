import { commonCopy } from "../lib/i18n/messages/common.js";
import React, { useId } from "react";
import Icon from "./Icon.jsx";
import useModalDialog from "./useModalDialog.js";

/**
 * A dialog with a sticky header (title + close button). Children render as before; a
 * dialog that passes `footer` gets a padded, scrollable `.dialog-body` and a sticky
 * `.dialog-actions` footer, so its actions stay visible however long the body is.
 * On phones it becomes a bottom sheet with a grab handle.
 */
export default function Modal({
  title,
  children,
  footer,
  close,
  wide = false,
  className = "",
  style,
  closeDisabled = false,
  dismissOnBackdrop = false,
  closeIcon,
}) {
  const ref = useModalDialog();
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      style={style}
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
      {footer === undefined ? (
        children
      ) : (
        <>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-actions">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
