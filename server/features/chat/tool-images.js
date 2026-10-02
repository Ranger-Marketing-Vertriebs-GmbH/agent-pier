export const TOOL_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const payload = (value) => {
  if (!record(value) || value.type !== "image") return null;
  if (record(value.source) && typeof value.source.data === "string")
    return { mime: value.source.media_type, data: value.source.data };
  if (typeof value.data === "string")
    return { mime: value.mimeType || value.mime_type, data: value.data };
  return null;
};
// Images leave the serialized tool text so chat payloads stay small; the chat
// serves them separately and shows them as real images on demand.
export function extractToolImages(value, images) {
  const image = payload(value);
  if (image && TOOL_IMAGE_TYPES.has(image.mime)) {
    images.push(image);
    return `[image ${images.length}]`;
  }
  if (Array.isArray(value)) return value.map((entry) => extractToolImages(entry, images));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, extractToolImages(entry, images)]),
  );
}
const placeholdersFrom = (images, start) =>
  images
    .slice(start)
    .map((_, index) => `[image ${start + index + 1}]`)
    .join("\n");
export function imagePlaceholders(value, images) {
  const start = images.length;
  extractToolImages(value, images);
  return placeholdersFrom(images, start);
}
const dataUrl = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;
// OpenCode tools (for example read) report images as file attachments with a
// base64 data URL beside a plain string output.
export function attachmentPlaceholders(attachments, images) {
  if (!Array.isArray(attachments)) return "";
  const start = images.length;
  for (const attachment of attachments) {
    if (!record(attachment) || attachment.type !== "file") continue;
    if (!TOOL_IMAGE_TYPES.has(attachment.mime) || typeof attachment.url !== "string")
      continue;
    const match = dataUrl.exec(attachment.url);
    if (match && match[1] === attachment.mime)
      images.push({ mime: attachment.mime, data: match[2] });
  }
  return placeholdersFrom(images, start);
}
