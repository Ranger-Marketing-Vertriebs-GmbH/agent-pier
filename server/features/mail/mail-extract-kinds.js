// The kinds an extraction child answers (mail-extract-child.js), one list for the
// parent that picks a pool (mail-extract.js) and the child that picks a reader. Kept
// free of imports, so the child loads nothing else for it.

/** Attachment documents, read in the document pool. */
export const documentKinds = Object.freeze(new Set(["pdf", "docx", "xlsx", "pptx"]));

/** Mail HTML, read in the HTML pool. */
export const htmlKinds = Object.freeze(
  new Set(["html-text", "html-quote", "html-forward"]),
);
