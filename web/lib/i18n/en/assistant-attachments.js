export const assistantAttachmentsCopy = Object.freeze({
  attach: "Attach file or image",
  choose: "Choose files or images",
  list: "Attachments",
  sent: "Attached files",
  shared: "Shared files",
  sharedUnavailable: "This shared file is no longer available.",
  remove: (name) => `Remove ${name}`,
  open: (name) => `Open ${name}`,
  download: (name) => `Download ${name}`,
  uploading: "Uploading …",
  failed: "Upload failed",
  tooLarge: (name) => `"${name}" is larger than 10 MB.`,
  unsupported: (name) =>
    `"${name}" is not supported. You can attach images (JPEG, PNG, WebP, GIF, HEIC), PDF and text files.`,
  tooMany: (max) => `A message can hold at most ${max} files.`,
  noImageInput:
    "This agent's model can't see images. Images are only saved in its workspace so it can read them with its tools.",
  heicKept:
    "HEIC photos this browser can't convert reach the agent only as a file in its workspace.",
  drop: "Drop files here",
});
