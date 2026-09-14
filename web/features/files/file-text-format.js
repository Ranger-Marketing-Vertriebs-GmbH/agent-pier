import { fileEditorCopy } from "../../lib/i18n/messages/file-editor.js";

export function serializeDocument(document, text, { mixedLineEnding = null } = {}) {
  const ending = document.lineEnding === "mixed" ? mixedLineEnding : document.lineEnding;
  if (!["lf", "crlf"].includes(ending)) {
    const error = Object.assign(new Error(), { code: "FILE_LINE_ENDING_REQUIRED" });
    Object.defineProperty(error, "message", {
      get: () => fileEditorCopy.lineEndingRequired,
    });
    throw error;
  }
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const body = ending === "crlf" ? normalized.replaceAll("\n", "\r\n") : normalized;
  return new TextEncoder().encode((document.bom ? "\uFEFF" : "") + body);
}
