import { chatAttachmentsCopy as copy } from "../../lib/i18n/de/chat.js";
import { chatUploadsCopy as uploadsCopy } from "../../lib/i18n/de/chat-uploads.js";
import { useEffect, useRef, useState } from "react";
import { deliveryScope } from "./chat-draft.js";
import { uploadLock, uploadStore } from "./chat-upload-store.js";
import { uploadFile } from "./chat-upload-transport.js";

const MAX_ATTACHMENTS = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export default function useChatAttachments({
  session,
  disabled,
  attachments,
  setAttachments,
  draft,
}) {
  const scope = deliveryScope(session);
  const [error, setError] = useState("");
  const [pending, setPending] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const operation = useRef(null);
  const live = useRef(false);
  const supported =
    session.status === "running" &&
    !session.pipeline?.headless &&
    session.purpose !== "login" &&
    session.tool !== "shell";

  useEffect(() => {
    live.current = true;
    const restore = async () => {
      if (operation.current) return;
      try {
        const entries = await uploadLock(scope, async () => {
          const saved = await uploadStore(scope, "list");
          draft.reload();
          if (draft.getSnapshot().storageError)
            throw new Error(uploadsCopy.storageFailed);
          const epoch = draft.getSnapshot().epoch;
          const current = [];
          for (const item of saved) {
            if (item.epoch === epoch) current.push(item);
            else await uploadStore(scope, "delete", item.key);
          }
          return current;
        });
        if (!live.current || operation.current) return;
        setPending(
          entries.map((item) => ({
            ...item,
            status: "failed",
            error: uploadsCopy.interrupted,
          })),
        );
      } catch {
        if (live.current) setError(uploadsCopy.storageFailed);
      } finally {
        if (live.current) setLoading(false);
      }
    };
    restore();
    window.addEventListener("focus", restore);
    window.addEventListener("pageshow", restore);
    return () => {
      live.current = false;
      operation.current?.abort();
      window.removeEventListener("focus", restore);
      window.removeEventListener("pageshow", restore);
    };
  }, [scope, draft]);

  const update = (key, patch) => {
    if (live.current)
      setPending((current) =>
        current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
      );
  };
  const forget = async (key) => {
    await uploadStore(scope, "delete", key);
    if (live.current) setPending((current) => current.filter((item) => item.key !== key));
  };
  const transfer = async (entry, signal) => {
    try {
      if (signal.aborted) return;
      draft.reload();
      // A sent/cleared draft must never regain files from an older recovery copy.
      if (draft.getSnapshot().epoch !== entry.epoch) {
        await forget(entry.key);
        return;
      }
      if (draft.getSnapshot().outbox) throw new Error(uploadsCopy.interrupted);
      update(entry.key, { status: "uploading", progress: 0, error: "" });
      let receipt = entry.receipt;
      if (!receipt) {
        receipt = await uploadFile(session, entry.file, signal, (progress) =>
          update(entry.key, { progress }),
        );
        // Keep the server receipt with the blob until the completed manifest is durable.
        await uploadStore(scope, "put", { ...entry, receipt });
      }
      update(entry.key, { receipt });
      if (signal.aborted || !live.current) return;
      draft.reload();
      const state = draft.getSnapshot();
      if (state.epoch !== entry.epoch) {
        await forget(entry.key);
        return;
      }
      if (state.outbox) throw new Error(uploadsCopy.interrupted);
      const committed = await draft.mutate((saved) => {
        if (saved.epoch !== entry.epoch || saved.outbox) return false;
        if (saved.attachments.some((item) => item.path === receipt.path)) return true;
        if (saved.attachments.length >= MAX_ATTACHMENTS) return false;
        return draft.write({ ...saved, attachments: [...saved.attachments, receipt] });
      });
      if (!committed) throw new Error(uploadsCopy.storageFailed);
      if (
        draft.getSnapshot().storageError ||
        !draft.getSnapshot().attachments.some((item) => item.path === receipt.path)
      )
        throw new Error(uploadsCopy.storageFailed);
      await forget(entry.key);
    } catch (err) {
      update(entry.key, { status: "failed", error: err.message });
    }
  };
  const run = async (action) => {
    if (operation.current || disabled || !supported) return;
    const controller = new AbortController();
    operation.current = controller;
    setUploading(true);
    setError("");
    try {
      await uploadLock(scope, async () => {
        if (!controller.signal.aborted) await action(controller.signal);
      });
    } catch {
      if (live.current) {
        setError(uploadsCopy.storageFailed);
        setPending((current) =>
          current.map((item) => ({
            ...item,
            status: "failed",
            error: uploadsCopy.storageFailed,
          })),
        );
      }
    } finally {
      operation.current = null;
      if (live.current) setUploading(false);
    }
  };
  const add = (files) => {
    const selected = [...files];
    return run(async (signal) => {
      const existing = await uploadStore(scope, "list");
      setPending((current) => [
        ...current,
        ...existing
          .filter((item) => !current.some((row) => row.key === item.key))
          .map((item) => ({ ...item, status: "failed", error: uploadsCopy.interrupted })),
      ]);
      draft.reload();
      let total = draft.getSnapshot().attachments.length + existing.length;
      const batch = [];
      for (const file of selected) {
        if (signal.aborted) return;
        if (total >= MAX_ATTACHMENTS) {
          setError(copy.tooManyFiles);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          setError(copy.fileTooLarge);
          continue;
        }
        const entry = {
          key: crypto.randomUUID(),
          name: file.name,
          file,
          epoch: draft.getSnapshot().epoch,
        };
        await uploadStore(scope, "put", entry);
        total++;
        setPending((current) => [...current, { ...entry, status: "waiting" }]);
        batch.push(entry);
      }
      for (const entry of batch) await transfer(entry, signal);
    });
  };
  const retry = (key) =>
    run(async (signal) => {
      const entry = (await uploadStore(scope, "list")).find((item) => item.key === key);
      if (entry) await transfer(entry, signal);
      else setPending((current) => current.filter((item) => item.key !== key));
    });
  const remove = (key) => {
    if (operation.current || disabled) return;
    if (pending.some((item) => item.key === key)) return run(() => forget(key));
    return draft.mutate((saved) => {
      if (saved.outbox) return false;
      return draft.write({
        ...saved,
        attachments: saved.attachments.filter((item) => item.key !== key),
      });
    });
  };
  const clear = () => {
    setAttachments([]);
    setError("");
  };
  return {
    attachments,
    pending,
    add,
    retry,
    remove,
    clear,
    error,
    uploading,
    loading,
    supported,
    blocked: loading || pending.length > 0,
  };
}
