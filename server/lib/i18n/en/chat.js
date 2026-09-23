/** English product copy, addressed through the same semantic keys as the German catalog. */
export const chat = Object.freeze({
  imageNotFound: "Image not found.",
  imageHistoryMismatch: "This image does not belong to the current chat history.",
  imageNotRegularFile: "The image is not available as a regular file.",
  imageChangedDuringRead: "The image file changed while it was being read.",
  imageTooLarge: "The image file is larger than 20 MiB.",
  imageChangedOrTooLarge: "The image file was changed or is too large.",
  unsupportedImageFormat:
    "Unsupported raster image. Allowed formats are PNG, JPEG, GIF, WebP and AVIF.",
  imageUnreadable: "The image file is missing or cannot be read.",
  attachmentInvalidPayload: "Invalid image attachment.",
  attachmentTooLarge: "The image attachment is larger than 10 MiB.",
  attachmentUnsupportedFormat:
    "Unsupported raster image. Allowed formats are PNG, JPEG, GIF, WebP and AVIF.",
  attachmentLimitReached:
    "This session has reached the maximum number of saved image attachments.",
  attachmentSessionUnavailable:
    "Image attachments are only possible in running sessions with image access. Please restart the session.",
  attachmentWriteFailed: "The image attachment could not be saved.",
  linkUnavailable: "No chat link is available for this session.",
  historySelectionRequired: "Please select a history from this account and project.",
  recentMessageLimit: "Showing the last 500 messages.",
  historyUnavailable: "No chat history is available for this session.",
  loginInTerminal: "Sign-in takes place in the terminal.",
  shellInTerminal: "Shell sessions are shown in the terminal.",
  startNativeConversation:
    "Open or start a conversation in the native terminal. The chat view connects automatically.",
  codexBindingPending:
    "The chat view is waiting for the native session ID. If Codex reports new hooks for review, review them under /hooks in the terminal.",
  nativeBindingPending: "The chat view connects to this native session automatically.",
  linkedAccountMismatch: "The linked history belongs to a different account.",
  savedHistoryNotice: "Saved chat history of this stopped session.",
  emptyHistoryNotice:
    "No messages yet. If a sign-in or approval is pending, open the terminal.",
  invalidHistoryId: "Invalid history ID.",
  historyTooLarge:
    "This history is too large for the chat view. Please use the terminal.",
  historyOutsideProfile: "The history is outside the selected profile.",
  codexVersionUnsupported:
    "Codex cannot read this history with the installed version. Please use the terminal.",
  codexHistoryUnavailable: "Codex history is currently unavailable.",
  serviceStopping: "The history service is stopping.",
  sessionToolMismatch: "Session and account belong to different tools.",
  cliUnavailableOnHost: (toolName) => `${toolName} is not installed on this computer.`,
  sessionHistoryPending: "The history of this session is not available yet.",
  openCodeHistoryUnavailable:
    "OpenCode cannot read the history right now. Please check the installation and CLI version.",
  sessionHistoryBeingWritten: "The history of this session is still being written.",
  sessionHistoryMismatch:
    "This history does not belong to the selected session and its project.",
  historyProjectMismatch: "This history belongs to a different project.",
  readOnlyHistoryRequired: "Only read-only history operations are allowed.",
  codexDisconnected: "The Codex connection was closed.",
  codexReadTimeout: "Reading the Codex history took too long.",
});
export const chatAttachmentCopy = {
  invalidSession: "Invalid session for file upload.",
  unavailable: "Files cannot be added to this session right now.",
  invalidName: "Invalid file name.",
  invalidBody: "The uploaded file could not be read.",
  tooLarge: "A file can be at most 10 MB.",
};
