export const assistantAttachmentsCopy = Object.freeze({
  attach: "Attach file, image or video",
  choose: "Choose files, images or videos",
  list: "Attachments",
  sent: "Attached files",
  shared: "Shared files",
  sharedUnavailable: "This shared file is no longer available.",
  deleteLabel: "Delete",
  deleteShared: (name) => `Delete ${name}`,
  deleteConfirm: (name) =>
    `Delete "${name}" from AgentPier? The file in the agent's workspace stays.`,
  deleteYes: "Delete",
  deleteNo: "Keep",
  remove: (name) => `Remove ${name}`,
  open: (name) => `Open ${name}`,
  download: (name) => `Download ${name}`,
  audio: (name) => `Audio: ${name}`,
  uploading: "Uploading …",
  uploadingProgress: (percent) => `Uploading … ${percent} %`,
  video: (name) => `Video ${name}`,
  videoTooLarge: (name) => `"${name}" is larger than 200 MB.`,
  failed: "Upload failed",
  tooLarge: (name) => `"${name}" is larger than 10 MB.`,
  unsupported: (name) =>
    `"${name}" is not supported. You can attach images (JPEG, PNG, WebP, GIF, HEIC), videos (MP4, MOV, WebM), PDF and text files.`,
  tooMany: (max) => `A message can hold at most ${max} files.`,
  noImageInput:
    "This agent's model can't see images. Images are only saved in its workspace so it can read them with its tools.",
  heicKept:
    "HEIC photos this browser can't convert reach the agent only as a file in its workspace.",
  unavailable: "No longer available",
  storageGroup: "Chat attachments",
  storageHint:
    "Files you send this agent are saved in attachments/ of its workspace, so it can read them with its tools.",
  storageUsage: (bytes, maxBytes, files, maxFiles) =>
    `${bytes} of ${maxBytes} · ${files} of ${maxFiles} files`,
  storageLoading: "Reading the folder …",
  storageReplaced:
    "The agent replaced attachments/ with something that is not a folder, so uploads are blocked. Clearing removes it; the next upload creates the folder again.",
  storageClear: "Clear attachments",
  storageClearDescription:
    "Deletes every file in attachments/, also files the agent put there and videos still uploading. Sent messages keep the file names, marked as no longer available. Files the agent shared with you stay.",
  storageClearTitle: "Clear this agent's attachments?",
  storageClearConfirm: "Clear",
  storageClearCancel: "Cancel",
  storageCleared: "Attachments cleared.",
  drop: "Drop files here",
});
