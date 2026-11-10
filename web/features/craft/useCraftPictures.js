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

let next = 0;

/**
 * The pictures picked for the next start or follow-up, kept in the browser until it
 * is sent: `{ items, error, add(files), remove(key), clear(), upload() }`, shaped for
 * AgentAttachmentTray. `upload()` sends them one by one and resolves their ids.
 */
export default function useCraftPictures() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const held = useRef(items);
  held.current = items;
  // Previews are object URLs: each goes with its picture, all with the page.
  useEffect(
    () => () => held.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)),
    [],
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
  const remove = useCallback((key) => {
    setError("");
    setItems((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((item) => item !== gone);
    });
  }, []);
  const clear = useCallback(() => {
    setError("");
    setItems((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
  }, []);
  const upload = useCallback(async () => {
    const ids = [];
    for (const item of held.current) ids.push(await uploadPicture(item.file));
    return ids;
  }, []);
  return { items, error, add, remove, clear, upload };
}
