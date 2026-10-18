import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import Sheet from "../../../components/Sheet.jsx";
import { assistantAttachmentsCopy as copy } from "../../../lib/i18n/messages/assistant-attachments.js";
import { formatNumber } from "../../../lib/i18n/index.js";
import { assistantApi } from "../assistant-api.js";
import { fileSize } from "../AgentMessageAttachments.jsx";

// Only a complete answer is shown; anything else keeps the row waiting.
const valid = (usage) =>
  [usage?.files, usage?.bytes, usage?.maxFiles, usage?.maxBytes].every(Number.isFinite)
    ? usage
    : null;
const usageText = (usage) =>
  copy.storageUsage(
    fileSize(usage.bytes),
    fileSize(usage.maxBytes),
    `${formatNumber(usage.files)}${usage.capped ? "+" : ""}`,
    formatNumber(usage.maxFiles),
  );

/**
 * The agent's attachments folder (docs/agents.md "Attachments"): how much of its
 * quota it uses, and clearing it after one confirmation. Clearing is data loss: the
 * sheet focuses Cancel (itself on touch screens), so Enter never confirms.
 */
export default function AttachmentStorageGroup({ assistant }) {
  const id = useId();
  const agentId = assistant.id;
  const [usage, setUsage] = useState(null),
    [error, setError] = useState(""),
    [result, setResult] = useState(""),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setUsage(null);
    setError("");
    assistantApi
      .attachmentUsage(agentId, controller.signal)
      .then((next) => setUsage(valid(next)))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [agentId]);
  const clear = async () => {
    setConfirming(false);
    setBusy(true);
    setResult("");
    setError("");
    try {
      setUsage(valid(await assistantApi.clearAttachments(agentId)));
      setResult(copy.storageCleared);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.storageHint}>
        {copy.storageGroup}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.list}
          sub={usage ? usageText(usage) : error || copy.storageLoading}
        />
        <ListRow
          label={copy.storageClear}
          sub={copy.storageClearDescription}
          disabled={busy || !usage || usage.files === 0}
          onClick={() => setConfirming(true)}
        />
      </ListCard>
      {result && (
        <p role="status" className="assistant-notice">
          {result}
        </p>
      )}
      {error && usage && (
        <p role="alert" className="assistant-notice">
          {error}
        </p>
      )}
      {confirming && (
        <Sheet
          open
          title={copy.storageClearTitle}
          onCancel={() => setConfirming(false)}
          className="agent-confirmation-sheet"
        >
          <div className="sheet-body">
            <p>{usageText(usage)}</p>
            <p>{copy.storageClearDescription}</p>
          </div>
          <div className="sheet-actions">
            <button type="button" className="button danger" onClick={clear}>
              {copy.storageClearConfirm}
            </button>
            <button
              type="button"
              className="button secondary"
              data-autofocus
              onClick={() => setConfirming(false)}
            >
              {copy.storageClearCancel}
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
