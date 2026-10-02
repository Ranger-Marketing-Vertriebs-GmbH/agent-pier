import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import ToolOutput from "./ToolOutput.jsx";

const formatSize = (bytes) =>
  bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
const utf8 = (value) => new TextEncoder().encode(value).length;

export default function TruncatedToolOutput({ message, sessionId }) {
  useLanguage();
  const [full, setFull] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFull(null);
    setError("");
  }, [message.id, message.truncated.length]);
  if (full !== null) return <ToolOutput text={full} toolName={message.toolName} />;
  const omitted =
    message.truncated.bytes - utf8(message.text) - utf8(message.textTail || "");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/sessions/${encodeURIComponent(sessionId)}/chat/messages/${encodeURIComponent(message.id)}/text`,
      );
      if (typeof result?.text !== "string") throw new Error(copy.loadFullOutputFailed);
      setFull(result.text);
    } catch (failure) {
      setError(failure.message || copy.loadFullOutputFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tool-output-truncated">
      <ToolOutput text={message.text} toolName={message.toolName} />
      <p className="tool-output-omitted">
        {copy.outputOmitted(formatSize(Math.max(omitted, 0)))}
      </p>
      <ToolOutput text={message.textTail || ""} toolName={message.toolName} />
      {error && (
        <p className="tool-output-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="button" disabled={busy} onClick={load}>
        {copy.loadFullOutput(formatSize(message.truncated.bytes))}
      </button>
    </div>
  );
}
