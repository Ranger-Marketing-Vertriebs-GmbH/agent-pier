// Markdown files in the agent chat open as a rendered preview (AgentMarkdownPreview).
// The server stores them as text/plain by their bytes, so the name decides; a file an
// agent shares may also carry text/markdown.

/** The most of a Markdown file the preview fetches and renders: 512 KiB. */
export const MARKDOWN_PREVIEW_MAX_BYTES = 512 * 1024;

const markdownName = /\.(md|markdown)$/i;
const media = new Set(["image", "video", "audio"]);

/** Whether a chat file is a Markdown file the chat can preview. */
export function isMarkdownAttachment(file) {
  if (!file || file.unavailable || media.has(file.kind)) return false;
  const type = String(file.type || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return markdownName.test(String(file.name || "")) || type === "text/markdown";
}

/** Whether its recorded size is above the preview cap (unknown sizes are read capped). */
export function markdownTooLarge(file, max = MARKDOWN_PREVIEW_MAX_BYTES) {
  return Number.isFinite(file?.size) && file.size > max;
}

/**
 * Reads a response body as UTF-8 text, at most `max` bytes: `{ text }`, or
 * `{ tooLarge: true }` as soon as the body passes the cap (the rest is not read).
 */
export async function readMarkdown(response, max = MARKDOWN_PREVIEW_MAX_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.();
    return { tooLarge: true };
  }
  const decoder = new TextDecoder("utf-8");
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > max ? { tooLarge: true } : { text: decoder.decode(bytes) };
  }
  const reader = response.body.getReader();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}
