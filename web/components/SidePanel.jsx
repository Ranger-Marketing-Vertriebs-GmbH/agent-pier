import { commonCopy } from "../lib/i18n/messages/common.js";
import React, { useEffect, useRef, useId } from "react";
import Icon from "./Icon.jsx";
export default function SidePanel({
  title,
  subtitle,
  close,
  closeDisabled = false,
  footer,
  children,
  cancelLabel = commonCopy.cancel,
  opener = null,
}) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    // `opener` names the element that opened it: Safari does not focus a clicked button.
    const back = opener || document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      // React removes the panel before this cleanup, so focus has fallen back to the
      // body; an element the closing action focused itself keeps it.
      const active = document.activeElement;
      if (active && active !== document.body && !dialog.contains(active)) return;
      if (back instanceof HTMLElement && back.isConnected)
        back.focus({ preventScroll: true });
    };
    // Opened once; the opener is read when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <dialog
      ref={ref}
      className="side-panel"
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) close();
      }}
      onClick={(e) => {
        if (closeDisabled) return;
        if (e.target === e.currentTarget) {
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
      <div className="side-panel-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          aria-label={commonCopy.closeDialog}
          disabled={closeDisabled}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="side-panel-body">{children}</div>
      <div className="side-panel-footer">
        <button
          type="button"
          className="button secondary"
          disabled={closeDisabled}
          onClick={close}
        >
          {cancelLabel}
        </button>
        {footer}
      </div>
    </dialog>
  );
}
