import { hermesError } from "./hermes-rpc-client.js";

// The images a turn carries inline (agent-attachments.js delivery: the owner's PNG,
// JPEG, GIF and WebP attachments within OpenClaw's limits, only for a model that may
// take images) reach a Hermes agent's model as image parts, as an OpenClaw agent's
// do, but only while its home routes images natively (`agent.image_input_mode:
// native` with `model.supports_vision`, home.js `nativeImages`): Hermes's other route
// describes each image with an extra vision call before the turn
// (gateway/run_inbound.py `_enrich_message_with_vision`), which OpenClaw never does.
// Hermes's messaging gateway takes a turn's images the way its local clients send
// them: `image.attach_bytes { session_id, content_base64, ext }` stages each one in
// the profile's image cache (gateway/session_images.py) and answers its
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
 * Stages `images` for session `sid` within one call's time in all (`timeoutMs`), so a
 * turn with images holds the send no longer than one without; resolves the
 * `attachments` of its submit. An image Hermes refuses (`invalid_params`: not an image
 * it takes, over its size cap) is left out, as the text names its file; any other
 * failure (the session is not attached here, a refusal, no answer in time) throws.
 */
export async function stageImages(
  client,
  sid,
  images,
  { timeoutMs, now = Date.now } = {},
) {
  const attachments = [];
  const deadline = now() + (timeoutMs ?? client.timeoutMs);
  for (const image of images) {
    const left = deadline - now();
    if (left <= 0) throw hermesError("TIMEOUT");
    try {
      const staged = await client.call(
        "image.attach_bytes",
        { session_id: sid, content_base64: image.content, ext: image.ext },
        { timeoutMs: left },
      );
      if (typeof staged?.path === "string" && typeof staged.mime === "string")
        attachments.push({ path: staged.path, mime: staged.mime });
    } catch (error) {
      if (error?.answered && error.reason === "invalid_params") continue;
      throw error;
    }
  }
  return attachments;
}

/**
 * The refusal of a turn whose images could not be staged: nothing was submitted, so
 * the turn fails at once (conversation-turns.js sendRefusal: "refused") instead of
 * waiting as one Hermes may run.
 */
export const notSubmitted = (error) =>
  Object.assign(hermesError("UNAVAILABLE"), {
    answered: true,
    retryable: false,
    stage: error?.code ?? "UNKNOWN",
  });

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A user row's text without what Hermes added for the images of its turn, which it
 * names by their files in the agent's own HERMES_HOME (`homes`: its spellings). The
 * native route stores the text, a blank line, `[Image attached at: <path>]` per image
 * (agent/image_routing.py `build_native_content_parts`) and, in the row's text view,
 * one `[screenshot]` per image part; the description route puts its notes before
 * the text, each ending in `image_url: <path> ~]` or `image_url: <path>]`
 * (gateway/run_inbound.py `_enrich_message_with_vision`). Only lines naming files
 * of that home's cache count, so the owner's own words always stay.
 */
export function sentText(text, homes = []) {
  if (typeof text !== "string" || !homes.length) return text;
  const caches = homes.map((home) => `${home.replace(/\/+$/, "")}/cache/`);
  const cached = (file) => caches.some((cache) => file.startsWith(cache));
  let body = text;
  const lines = body.split("\n");
  let end = lines.length;
  let shots = 0;
  while (end > 0 && lines[end - 1] === "[screenshot]") (shots++, end--);
  let hints = 0;
  for (let hint; end > 0; end--, hints++) {
    hint = /^\[Image attached at: ([^\n\]]+)\]$/.exec(lines[end - 1]);
    if (!hint || !cached(hint[1])) break;
  }
  if (hints && (!shots || shots === hints) && end > 0 && lines[end - 1] === "")
    body = lines.slice(0, end - 1).join("\n");
  if (body.startsWith("[The user sent an image")) {
    const notes = caches.map(escaped).join("|");
    const ending = new RegExp(`image_url: (?:${notes})[^\\n]*?(?: ~)?\\]\\n\\n`, "g");
    for (const match of body.matchAll(ending)) {
      const rest = body.slice(match.index + match[0].length);
      if (!rest.startsWith("[The user sent an image")) return rest;
    }
  }
  return body;
}
