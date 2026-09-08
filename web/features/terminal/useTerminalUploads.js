import { useEffect, useRef, useState } from "react";
import { uploadFile } from "../chat/chat-upload-transport.js";
import { chatAttachmentsCopy as copy } from "../../lib/i18n/messages/chat.js";

export const terminalPath = (path) => `'${path.replaceAll("'", "'\\''")}' `;

export default function useTerminalUploads({ session, paste }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(null);
  const supported =
    session.status === "running" &&
    !session.pipeline?.headless &&
    session.purpose !== "login" &&
    session.tool !== "shell";
  useEffect(() => () => operation.current?.abort(), [session.id]);
  const update = (key, patch) =>
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  const run = async (batch) => {
    if (operation.current || !supported) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      for (const entry of batch) {
        if (controller.signal.aborted) break;
        update(entry.key, { status: "uploading", error: "", progress: 0 });
        try {
          const receipt = await uploadFile(
            session,
            entry.file,
            controller.signal,
            (progress) => {
              if (!controller.signal.aborted) update(entry.key, { progress });
            },
          );
          if (controller.signal.aborted) break;
          // Server paths cannot contain terminal control characters. Quoting also
          // keeps spaces and shell metacharacters literal in the current input.
          if (/[\x00-\x1f\x7f]/.test(receipt.path)) throw new Error(copy.uploadFailed);
          update(entry.key, { status: "done", path: receipt.path, file: null });
          paste(terminalPath(receipt.path));
        } catch (err) {
          if (!controller.signal.aborted)
            update(entry.key, { status: "failed", error: err.message });
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        operation.current = null;
      }
    }
  };
  const add = (files) => {
    if (operation.current || !supported) return;
    setError("");
    const batch = [];
    for (const file of files) {
      if (items.length + batch.length >= 8) {
        setError(copy.tooManyFiles);
        break;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(copy.fileTooLarge);
        continue;
      }
      batch.push({ key: crypto.randomUUID(), name: file.name, file, status: "waiting" });
    }
    setItems((current) => [...current, ...batch]);
    if (batch.length) run(batch);
  };
  return {
    items,
    error,
    busy,
    supported,
    add,
    retry: (key) => {
      const item = items.find((item) => item.key === key);
      if (item?.file) {
        setError("");
        run([item]);
      }
    },
    remove: (key) => {
      if (!busy) setItems((current) => current.filter((item) => item.key !== key));
    },
  };
}
