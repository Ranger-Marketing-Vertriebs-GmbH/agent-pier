import React, { useState } from "react";
import CopyButton from "../../components/CopyButton.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import api from "../../lib/api.js";
import { formatMessageTime } from "../../lib/i18n/index.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import { serverText } from "../../lib/server-messages.js";
import { sshStatus } from "./connection-items.js";

/** POST /ssh-accesses/:id/test; the stored result arrives with the next list read. */
export const testAccess = (id) =>
  api(`/ssh-accesses/${encodeURIComponent(id)}/test`, "POST");

/** The last test as one line ("Test fehlgeschlagen · gestern 21:14"). */
export function testLine(access) {
  const status = sshStatus(access);
  if (status === "untested") return copy.test.never;
  const time = formatMessageTime(access.lastTest.at);
  return status === "ok"
    ? copy.test.ok(time)
    : status === "hostKey"
      ? copy.test.hostKey(time)
      : copy.test.failed(time);
}

export const statusTone = {
  ok: "ok",
  failed: "error",
  hostKey: "error",
  untested: "idle",
};

/**
 * "Letzter Test" of an SSH/SFTP access: when it ran, the server's own message and
 * the sanitized OpenSSH line of a failure, what to check, who is affected, and
 * "Erneut testen". A test reloads the list so the stored result shows.
 */
export default function SshTestBox({ access, affected = [], onTested, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rejected, setRejected] = useState(false);
  const test = access.lastTest;
  const status = sshStatus(access);
  const failed = status === "failed" || status === "hostKey";
  const run = async () => {
    setBusy(true);
    setError("");
    setRejected(false);
    try {
      const result = await testAccess(access.id);
      setRejected(result?.commandRejected === true);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
      onTested?.();
    }
  };
  const message = test?.error ? serverText(test.error, test.messageKey) : "";
  return (
    <section
      className={["connections-test", failed ? "is-failed" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label={copy.test.title}
    >
      <h3 className="connections-eyebrow">{copy.test.title}</h3>
      <p className="connections-test-line">
        <StatusDot tone={statusTone[status]} />
        <span>{testLine(access)}</span>
      </p>
      {failed && message && (
        <p className="connections-test-message" role="alert">
          {access.name}: {message}
        </p>
      )}
      {failed && test?.detail && (
        <pre className="connections-test-detail">{test.detail}</pre>
      )}
      {test?.ok && test.commandRejected && <p>{copy.test.rejected}</p>}
      {status === "failed" && access.publicKey && (
        <div className="connections-test-hint">
          <span>{copy.test.hintKey}</span>
          <CopyButton
            text={access.publicKey}
            label={sshCopy.copyKey}
            className="button secondary compact"
          />
        </div>
      )}
      {failed && affected.length > 0 && (
        <p className="connections-test-affected">
          {copy.test.affected(affected.join(", "))}
        </p>
      )}
      {rejected && <p role="status">{sshCopy.testRejected}</p>}
      <ErrorMessage error={error} />
      {busy && <p role="status">{copy.test.running}</p>}
      <div className="connections-actions">
        <button
          type="button"
          className={`button ${failed ? "primary" : "secondary"} compact`}
          disabled={busy}
          onClick={run}
        >
          {status === "untested" ? copy.test.run : copy.test.again}
        </button>
        {onEdit && (
          <button type="button" className="button secondary compact" onClick={onEdit}>
            {copy.edit}
          </button>
        )}
      </div>
    </section>
  );
}
