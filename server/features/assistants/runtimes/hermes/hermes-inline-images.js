// The images a turn carries inline (agent-attachments.js delivery: the owner's PNG,
// JPEG, GIF and WebP attachments within OpenClaw's limits, only for a model that may
// take images) reach a Hermes agent's model as image parts, as an OpenClaw agent's
// do. Hermes's messaging gateway takes a turn's images the way its local clients
// send them: `image.attach_bytes { session_id, content_base64, ext }` stages each
// one in the profile's image cache (gateway/session_images.py) and answers its
// `{ path, mime }`; `prompt.submit` names them as `attachments: [{ path, mime }]`,
// which the gateway commits as immutable bytes with the admission
// (gateway/session_ingress_media.py `admit_attachments`, at most 10), so a retried
// submission runs the same bytes. The turn's text still names the workspace copy of
// each file, for the agent's tools.

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
// Hermes's admission takes at most this many images per turn.
const maxImages = 10;

/** The turn's inline images Hermes can stage: `{ content (base64), ext }`. */
export function inlineImages(turn) {
  const list = Array.isArray(turn?.attachments) ? turn.attachments : [];
  return list
    .filter(
      (image) =>
        image?.type === "image" &&
        typeof image.content === "string" &&
        image.content &&
        extensions[image.mimeType],
    )
    .slice(0, maxImages)
    .map((image) => ({ content: image.content, ext: extensions[image.mimeType] }));
}

/**
 * Stages `images` for session `sid`; resolves the `attachments` of its submit. An
 * image Hermes refuses (`invalid_params`: not an image it takes, over its size cap)
 * is left out, as the text names its file; any other failure (the session is not
 * attached here, the channel closed) throws before anything was submitted.
 */
export async function stageImages(client, sid, images) {
  const attachments = [];
  for (const image of images) {
    try {
      const staged = await client.call("image.attach_bytes", {
        session_id: sid,
        content_base64: image.content,
        ext: image.ext,
      });
      if (typeof staged?.path === "string" && typeof staged.mime === "string")
        attachments.push({ path: staged.path, mime: staged.mime });
    } catch (error) {
      if (error?.answered && error.reason === "invalid_params") continue;
      throw error;
    }
  }
  return attachments;
}

// What Hermes adds to the stored user row of a turn with images: a line naming each
// committed image after a blank line (agent/image_routing.py
// `build_native_content_parts`), and in the text-only view of the row one
// `[screenshot]` per image part (session_history.py); its other views name them as
// `@image:<path>` lines or, unverified, as `data:` URLs.
const dataUrl = /\n?data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const added = [
  /^\[screenshot\]$/,
  /^\[Image attached(?: at)?: [^\n\]]+\]$/,
  /^@image:(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)$/,
];

/** A user row's text without what Hermes added for its images: the text sent. */
export function sentText(text) {
  if (typeof text !== "string" || !/\[Image attached|@image:/.test(text)) return text;
  const lines = text.replace(dataUrl, "").split("\n");
  let end = lines.length;
  while (end > 0 && added.some((line) => line.test(lines[end - 1]))) end--;
  if (end === lines.length) return text;
  if (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end).join("\n");
}
