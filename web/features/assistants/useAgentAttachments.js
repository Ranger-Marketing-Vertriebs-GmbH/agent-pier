import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
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
    return () => {
      live = false;
      // Unsent uploads leave with the chat; the server forgets them as well.
      for (const controller of uploads.values()) controller.abort();
      uploads.clear();
      for (const item of current.current)
        if (item.id)
          api(
            `${conversationPath(conversationId)}/attachments/${encodeURIComponent(item.id)}`,
            "DELETE",
          ).catch(() => {});
      current.current = [];
      setItems([]);
      setError("");
    };
  }, [conversationId]);

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
        // A data URL: the app's content policy allows no blob: images.
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
    if (item.id)
      api(
        `${conversationPath(conversationId)}/attachments/${encodeURIComponent(item.id)}`,
        "DELETE",
      ).catch(() => {});
  };

  // After a successful send: the server now owns the files as part of the message.
  const sent = () => {
    update([]);
    setError("");
  };

  return {
    items,
    error,
    imageInput,
    add,
    remove,
    sent,
    ids: items.filter((item) => item.status === "ready").map((item) => item.id),
    // Sending waits for uploads and for failed files to be removed.
    blocked: items.some((item) => item.status !== "ready"),
  };
}
