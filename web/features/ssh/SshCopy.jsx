import React, { useState } from "react";
import CopyButton from "../../components/CopyButton.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
export default function SshCopy({ label, text, button, compact = false }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="ssh-copy">
      {!compact && <strong>{label}</strong>}
      {(!compact || revealed) && (
        <pre tabIndex={0} aria-label={label}>
          {text}
        </pre>
      )}
      <CopyButton
        text={text}
        label={button}
        copiedLabel={copy.copied}
        failedLabel={copy.copyFailed}
        onFailed={() => setRevealed(true)}
      />
    </div>
  );
}
