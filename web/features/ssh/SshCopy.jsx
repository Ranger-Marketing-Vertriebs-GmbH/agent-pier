import React, { useState } from "react";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
export default function SshCopy({ label, text, button, compact = false }) {
  const [status, setStatus] = useState("");
  return (
    <div className="ssh-copy">
      {!compact && <strong>{label}</strong>}
      {(!compact || status === "copyFailed") && (
        <pre tabIndex={0} aria-label={label}>
          {text}
        </pre>
      )}
      <button
        className="button"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("copied");
          } catch {
            setStatus("copyFailed");
          }
        }}
      >
        {button}
      </button>
      {status && <p role="status">{copy[status]}</p>}
    </div>
  );
}
