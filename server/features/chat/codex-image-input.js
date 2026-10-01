import { createHash } from "node:crypto";

const MAX_BYTES = 10 * 1024 * 1024;
export function codexImageInput(content) {
  if (!Array.isArray(content)) return {};
  const images = content.filter((block) => block?.type === "image");
  const texts = content.filter((block) => block?.type === "text");
  if (
    !images.length ||
    images.length > 8 ||
    texts.length !== 1 ||
    content.length !== images.length + 1
  )
    return {};
  const text = texts[0].text;
  const elements = texts[0].textElements ?? texts[0].text_elements;
  if (typeof text !== "string" || !Array.isArray(elements)) return {};
  let offset = 0;
  // AgentPier pastes image chips first. Require Codex's explicit placeholder
  // ranges; a literal "[Image #1]" in authored prose is not image evidence.
  for (let i = 0; i < images.length; i++) {
    const label = /^\[Image #\d+\]/.exec(text.slice(offset))?.[0];
    if (
      !label ||
      !elements.some((element) => {
        const range = element?.byteRange ?? element?.byte_range;
        return (
          element?.placeholder === label &&
          range?.start === offset &&
          range?.end === offset + label.length
        );
      })
    )
      return {};
    offset += label.length;
    if (text[offset] === " ") offset++;
    else if (offset !== text.length) return {};
  }
  const hashes = [];
  for (const image of images) {
    const url = image.imageUrl ?? image.image_url;
    if (typeof url !== "string" || url.length > Math.ceil(MAX_BYTES / 3) * 4 + 64)
      return {};
    const match =
      /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match) return {};
    const bytes = Buffer.from(match[1], "base64");
    if (!bytes.length || bytes.length > MAX_BYTES) return {};
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  // Never retain data URLs in cached snapshots or send them to the browser.
  return { imageInput: { text: text.slice(offset), hashes } };
}
