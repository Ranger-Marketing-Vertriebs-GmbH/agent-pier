import path from "node:path";

// The one table of attachment types by file extension, for files an agent attaches
// (assistants/mail/agent-mail-sources.js), saves and reads as text. Any other
// extension is sent as `application/octet-stream`.
export const mailFileTypes = Object.freeze({
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
});

export const fallbackFileType = "application/octet-stream";

/** The MIME type of a file name by its extension, case-insensitive. */
export const mailFileType = (name) =>
  Object.hasOwn(mailFileTypes, path.extname(String(name)).toLowerCase())
    ? mailFileTypes[path.extname(String(name)).toLowerCase()]
    : fallbackFileType;
