import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import api from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";
import { fileDataUrl } from "../chat/chat-upload-transport.js";
import { AttachmentDraft } from "./agent-attachment-drafts.js";
import { uploadAttachment } from "./agent-attachment-upload.js";
import { useAgentPaths } from "./agent-paths.js";
import { sharedDrafts } from "./useAssistants.js";

const attachmentPath = (paths, conversationId, id) =>
  `${paths.conversation(conversationId)}/attachments/${encodeURIComponent(id)}`;

// The server routes of one chat's attachment draft (agent-attachment-drafts.js).
const transport = (paths, conversationId) => ({
  upload: (file, signal, progress) =>
    uploadAttachment(conversationId, file, signal, progress, paths),
  preview: fileDataUrl,
  discard: (id) => api(attachmentPath(paths, conversationId, id), "DELETE"),
  keep: (id) => api(attachmentPath(paths, conversationId, id)),
  leave: (id) =>
    fetch(`/api${attachmentPath(paths, conversationId, id)}`, {
      method: "DELETE",
      keepalive: true,
    })
      .then(observeBuild)
      .catch(() => {}),
});

/**
 * The files picked for the next message of one agent conversation, kept in the page's
 * draft store (sharedDrafts.attachments) so they survive leaving the chat like its
 * text. `imageInput` is false when the agent's model cannot see images.
 */
export default function useAgentAttachments(conversationId) {
  // The owner's or the user's routes (agent-paths.js); fixed for the app's lifetime.
  const paths = useAgentPaths();
  const key = paths.conversation(conversationId);
  const draft = useMemo(
    () =>
      sharedDrafts.attachments.entry(
        key,
        () => new AttachmentDraft(transport(paths, conversationId)),
      ),
    [key, paths, conversationId],
  );
  const { items, error } = useSyncExternalStore(draft.subscribe, draft.snapshot);
  const [imageInput, setImageInput] = useState(null);

  useEffect(() => {
    let live = true;
    setImageInput(null);
    api(`${paths.conversation(conversationId)}/attachment-policy`)
      .then((policy) => live && setImageInput(policy.imageInput ?? null))
      .catch(() => {});
    void draft.check();
    return () => {
      live = false;
      draft.forgetError();
      // After this chat's subscription is gone: an empty draft is dropped.
      queueMicrotask(() => sharedDrafts.attachments.release(key));
    };
  }, [conversationId, paths, draft, key]);

  return {
    items,
    error,
    imageInput,
    add: (files) => draft.add(files),
    remove: (itemKey) => draft.remove(itemKey),
    sent: (ids) => draft.sent(ids),
    restore: (files) => draft.restore(files),
    ids: items.filter((item) => item.status === "ready").map((item) => item.id),
    // Sending waits for uploads and for failed files to be removed.
    blocked: items.some((item) => item.status !== "ready"),
  };
}
