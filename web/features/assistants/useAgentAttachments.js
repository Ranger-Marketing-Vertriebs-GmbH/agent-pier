import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import { fileDataUrl } from "../chat/chat-upload-transport.js";
import {
  MAX_FILES,
  fileProblem,
  isImage,
  preparedFile,
  uploadAttachment,
} from "./agent-attachment-upload.js";

const conversationPath = (id) => `/assistant-conversations/${encodeURIComponent(id)}`;
const attachmentPath = (conversationId, id) =>
  `${conversationPath(conversationId)}/attachments/${encodeURIComponent(id)}`;
let nextKey = 0;

/**
 * The files picked for the next message of one agent conversation. Each file is
 * uploaded as soon as it is picked, so sending only names the server's ids; a file
 * removed before sending is discarded on the server too. `imageInput` is false when
 * the agent's model cannot see images.
 */
export default function useAgentAttachments(conversationId) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [imageInput, setImageInput] = useState(null);
  const current = useRef([]);
  const controllers = useRef(new Map());
  const queue = useRef(Promise.resolve());
  const update = useCallback((next) => {
    current.current = typeof next === "function" ? next(current.current) : next;
    setItems(current.current);
  }, []);
  const patch = (key, values) =>
    update((list) =>
      list.map((item) => (item.key === key ? { ...item, ...values } : item)),
    );

  useEffect(() => {
    let live = true;
    setImageInput(null);
    api(`${conversationPath(conversationId)}/attachment-policy`)
      .then((policy) => live && setImageInput(policy.imageInput ?? null))
      .catch(() => {});
    const uploads = controllers.current;
    // A reload or a closed tab unmounts nothing: the page discards its unsent uploads
    // as it goes, with requests that outlive it.
    const leave = () => {
      for (const item of current.current)
        if (item.id)
          fetch(`/api${attachmentPath(conversationId, item.id)}`, {
            method: "DELETE",
            keepalive: true,
          })
            .then(observeBuild)
            .catch(() => {});
    };
    // A page restored from the back-forward cache lost those files on the server.
    const back = (event) => {
      if (event.persisted) update((list) => list.filter((item) => !item.id));
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      live = false;
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      // Unsent uploads leave with the chat; the server forgets them as well.
      for (const controller of uploads.values()) controller.abort();
      uploads.clear();
      for (const item of current.current)
        if (item.id)
          api(attachmentPath(conversationId, item.id), "DELETE").catch(() => {});
      current.current = [];
      setItems([]);
      setError("");
    };
  }, [conversationId, update]);

  const upload = async (item, file) => {
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    try {
      const stored = await uploadAttachment(
        conversationId,
        file,
        controller.signal,
        (p) => patch(item.key, { progress: p }),
      );
      if (controller.signal.aborted) return;
      patch(item.key, { status: "ready", id: stored.id, name: stored.name });
    } catch (e) {
      if (!controller.signal.aborted)
        patch(item.key, { status: "failed", error: e.message || copy.failed });
    } finally {
      controllers.current.delete(item.key);
    }
  };

  const add = (files) => {
    const picked = [...(files || [])];
    if (!picked.length) return;
    setError("");
    let room = MAX_FILES - current.current.length;
    for (const original of picked) {
      if (room <= 0) {
        setError(copy.tooMany(MAX_FILES));
        break;
      }
      const problem = fileProblem(original);
      if (problem) {
        setError(problem);
        continue;
      }
      room--;
      const item = {
        key: `attachment-${++nextKey}`,
        name: original.name,
        size: original.size,
        image: isImage(original),
        status: "uploading",
        progress: 0,
      };
      update((list) => [...list, item]);
      // One upload at a time keeps the order and stays inside the server's budget.
      queue.current = queue.current.then(async () => {
        if (!current.current.some((entry) => entry.key === item.key)) return;
        const file = await preparedFile(original);
        // A data URL: the preview outlives the upload, and needs no revoking.
        if (item.image && /^image\/(?:jpeg|png|webp|gif)$/.test(file.type))
          patch(item.key, {
            previewUrl: await fileDataUrl(file).catch(() => undefined),
            name: file.name,
          });
        await upload(item, file);
      });
    }
  };

  const remove = (key) => {
    const item = current.current.find((entry) => entry.key === key);
    if (!item) return;
    controllers.current.get(key)?.abort();
    update((list) => list.filter((entry) => entry.key !== key));
    if (item.id) api(attachmentPath(conversationId, item.id), "DELETE").catch(() => {});
  };

  // After a successful send: the server now owns the sent files as part of the
  // message. Files picked while it was on its way stay for the next one.
  const sent = (ids) => {
    const gone = new Set(ids);
    update((list) => list.filter((item) => !gone.has(item.id)));
    setError("");
  };

  // A queued message taken back brings its files, still staged on the server.
  const restore = (files) =>
    update((list) => [
      ...files
        .filter((file) => !list.some((item) => item.id === file.id))
        .map((file) => ({
          key: `attachment-${++nextKey}`,
          id: file.id,
          name: file.name,
          size: file.size,
          image: file.kind === "image",
          status: "ready",
          progress: 1,
        })),
      ...list,
    ]);

  return {
    items,
    error,
    imageInput,
    add,
    remove,
    sent,
    restore,
    ids: items.filter((item) => item.status === "ready").map((item) => item.id),
    // Sending waits for uploads and for failed files to be removed.
    blocked: items.some((item) => item.status !== "ready"),
  };
}
