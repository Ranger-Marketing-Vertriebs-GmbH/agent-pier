import React, { useEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";

export default function SshDetails({ children, close }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      id="ssh-details"
      className="ssh-details"
      ref={ref}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        className="icon-button ssh-details-close"
        aria-label={copy.closeDetails}
        onClick={close}
      >
        <Icon name="close" />
      </button>
      {children}
    </div>
  );
}
