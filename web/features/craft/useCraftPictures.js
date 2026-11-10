import { useCallback, useEffect, useRef, useState } from "react";
import { apiError } from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";
import { craftCopy } from "../../lib/i18n/messages/craft.js";
import { preparedFile } from "../assistants/agent-attachment-upload.js";

// The server checks every picture again by its bytes (craft/rebuild-pictures.js);
// these mirror its limits so the owner learns about a wrong file before it is sent.
export const MAX_PICTURES = 10;
export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
const pictureTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// iOS hands photos over as HEIC; preparedFile makes them JPEG where it can.
const heic = (file) =>
  /^image\/hei[cf](?:-sequence)?$/.test(file.type) || /\.hei[cf]$/i.test(file.name);

/** A translated reason the file cannot be a picture of the original, or "". */
export function pictureProblem(file) {
  const copy = craftCopy.pictures;
  if (!pictureTypes.has(file.type) && !heic(file)) return copy.unsupported(file.name);
  if (file.size > MAX_PICTURE_BYTES) return copy.tooLarge(file.name);
  return "";
}

/** Uploads one picture as raw bytes (POST /api/craft/pictures); resolves its id. */
export async function uploadPicture(file, signal) {
  const response = observeBuild(
    await fetch("/api/craft/pictures", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/octet-stream" },
      body: await preparedFile(file),
    }),
  );
  if (!response.ok) throw await apiError(response);
  return (await response.json()).id;
}

/** Drops a staged picture the form no longer sends (DELETE /api/craft/pictures/:id). */
export function dropPicture(id) {
  // keepalive: also while the page goes away.
  fetch(`/api/craft/pictures/${encodeURIComponent(id)}`, {
    method: "DELETE",
    keepalive: true,
  })
    .then(observeBuild)
    .catch(() => {});
}

let next = 0;

/**
 * The pictures picked for the next start or follow-up, kept in the browser until it
 * is sent: `{ items, error, add(files), remove(key), clear(), upload(), sent() }`,
 * shaped for AgentAttachmentTray. `upload()` sends those not yet staged one by one
 * and resolves all their ids, so a retry after a failed upload sends each picture
 * once. A staged picture the form drops (removed, cleared unsent, the form gone) is
 * deleted on the server at once; `sent()` forgets the ids a start or follow-up was
 * sent with, since the server releases them whatever its answer.
 */
export default function useCraftPictures() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const held = useRef(items);
  held.current = items;
  // Staged ids by picture key.
  const staged = useRef(new Map());
  const drop = useCallback((key) => {
    const id = staged.current.get(key);
    staged.current.delete(key);
    if (id) dropPicture(id);
  }, []);
  // Previews are object URLs: each goes with its picture, all with the form, and
  // what it staged but never sent goes with them.
  useEffect(
    () => () => {
      held.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      [...staged.current.keys()].forEach(drop);
    },
    [drop],
  );
  const add = useCallback((list) => {
    const files = [...(list || [])];
    let problem = "";
    const accepted = [];
    for (const file of files) {
      const reason = pictureProblem(file);
      if (reason) problem ||= reason;
      else accepted.push(file);
    }
    const room = Math.max(0, MAX_PICTURES - held.current.length);
    if (accepted.length > room) problem ||= craftCopy.pictures.tooMany(MAX_PICTURES);
    const added = accepted.slice(0, room).map((file) => ({
      key: `picture-${(next += 1)}`,
      file,
      name: file.name,
      size: file.size,
      status: "ready",
      image: true,
      previewUrl: URL.createObjectURL(file),
    }));
    setError(problem);
    if (added.length) setItems((current) => [...current, ...added]);
  }, []);
  const remove = useCallback(
    (key) => {
      setError("");
      const gone = held.current.find((item) => item.key === key);
      if (!gone) return;
      URL.revokeObjectURL(gone.previewUrl);
      drop(key);
      held.current = held.current.filter((item) => item !== gone);
      setItems((current) => current.filter((item) => item !== gone));
    },
    [drop],
  );
  const clear = useCallback(() => {
    setError("");
    held.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    [...staged.current.keys()].forEach(drop);
    held.current = [];
    setItems([]);
  }, [drop]);
  const upload = useCallback(async () => {
    const ids = [];
    for (const item of held.current) {
      let id = staged.current.get(item.key);
      if (!id) {
        id = await uploadPicture(item.file);
        // Removed while it uploaded: it is not sent.
        if (!held.current.includes(item)) {
          dropPicture(id);
          continue;
        }
        staged.current.set(item.key, id);
      }
      ids.push(id);
    }
    return ids;
  }, []);
  const sent = useCallback(() => staged.current.clear(), []);
  return { items, error, add, remove, clear, upload, sent };
}
