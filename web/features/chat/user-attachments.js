// The composer sends attachments as one absolute path line each after the text
// (useChatController.js), and the native CLI records them that way. A user row
// shows those trailing lines as chips again instead of long data-folder paths.
const ATTACHMENT_LINE = /^\/.*\/chat-attachments\/(?:[^/]+\/){1,3}[^/]+$/;

export function attachmentName(path) {
  return String(path).split("/").at(-1);
}

/** The authored text and the attachment files below it; images already shown are left out. */
export function userAttachments(text, images = []) {
  if (typeof text !== "string" || !text) return { text: "", files: [] };
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let end = lines.length;
  while (end > 0 && ATTACHMENT_LINE.test(lines[end - 1].trim())) end--;
  if (end === lines.length) return { text, files: [] };
  const shown = new Set((images || []).map((image) => image?.path));
  return {
    text: lines.slice(0, end).join("\n").trimEnd(),
    files: lines
      .slice(end)
      .map((line) => line.trim())
      .filter((path) => !shown.has(path))
      .map((path) => ({ path, name: attachmentName(path) })),
  };
}
