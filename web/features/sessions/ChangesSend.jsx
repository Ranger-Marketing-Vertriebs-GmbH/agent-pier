import React, { useState } from "react";
import CodeBlock from "../../components/CodeBlock.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import { sessionChangesCopy as copy } from "../../lib/i18n/messages/sessions.js";
import { sendBatch } from "./changes-send.js";

const notices = {
  "too-long": () => copy.batchTooLong,
  copied: (reason) => (reason === "locked" ? copy.copiedLocked : copy.copiedNoChat),
};

/**
 * "Send to agent (n)": every open comment of the session, across its workspaces, goes
 * to the chat composer (`onSend` then shows the chat), else to the clipboard with a
 * status line, else into a dialog to copy by hand. `readDiff(workspaceId)` answers a
 * workspace's files; `markSent` is the review hook's write.
 */
export default function ChangesSend({ session, comments, readDiff, markSent, onSend }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const open = comments.filter((comment) => comment.status === "open").length;
  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const next = await sendBatch({ session, comments, readDiff, markSent });
      setResult(next);
      // A batch whose sent marking failed stays here with its error, so the owner
      // sees it before a second Send would append the same comments again.
      if (next.outcome === "appended" && !next.error) onSend?.();
    } catch (error) {
      setResult({ outcome: "failed", error: error?.message || String(error) });
    } finally {
      setBusy(false);
    }
  };
  const notice = notices[result?.outcome]?.(result.reason);
  return (
    <div className="changes-send">
      <button
        type="button"
        className="button primary"
        disabled={open === 0 || busy}
        onClick={send}
      >
        {copy.sendToAgent(open)}
      </button>
      {notice && (
        <p className="changes-send-status" role="status">
          {notice}
        </p>
      )}
      <ErrorMessage error={result?.error} />
      {result?.outcome === "shown" && (
        <Modal
          title={copy.showBatchTitle}
          close={() => setResult(null)}
          className="changes-send-batch"
          footer={null}
          wide
        >
          <p>{copy.showBatchHint}</p>
          <CodeBlock>{result.text}</CodeBlock>
        </Modal>
      )}
    </div>
  );
}
