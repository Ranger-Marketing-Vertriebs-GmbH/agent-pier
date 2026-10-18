import React, { useEffect, useState } from "react";
import Modal from "./Modal.jsx";
import { SAVE_PENDING_EVENT, shareFile } from "../lib/standalone.js";
import { fileLinkCopy as copy } from "../lib/i18n/messages/components.js";
import "./file-link.css";

/**
 * The second step of a save in a home-screen app: Safari opens the share sheet only
 * right after a tap, and fetching the file may use that tap up. The fetched file
 * waits here for one more tap (lib/standalone.js shareFile).
 */
export default function SavePrompt() {
  const [file, setFile] = useState(null);
  useEffect(() => {
    const pending = (event) => setFile(event.detail?.file || null);
    window.addEventListener(SAVE_PENDING_EVENT, pending);
    return () => window.removeEventListener(SAVE_PENDING_EVENT, pending);
  }, []);
  if (!file) return null;
  return (
    <Modal
      title={copy.title}
      close={() => setFile(null)}
      footer={
        <button
          type="button"
          className="button"
          onClick={async () => {
            const result = await shareFile(file).catch(() => "failed");
            if (result !== "tap") setFile(null);
          }}
        >
          {copy.tap}
        </button>
      }
    >
      <p className="file-link-name">{file.name}</p>
    </Modal>
  );
}
