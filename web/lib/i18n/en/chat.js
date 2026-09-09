export const chatComposerCopy = {
  requestPending: "Review requests or continue in the terminal.",
  messageSent: "Sent to the running session",
  touchSendHint: "Enter: new line · Use the button to send",
};
export const chatAttachmentsCopy = {
  attachAriaLabel: "Add file",
  choose: "Choose files",
  uploadFailed: "The file could not be uploaded.",
  attachButton: "Add file",
  dropHint: "Drop files here",
  removeAriaLabel: (name) => `Remove attachment: ${name}`,
  listAriaLabel: "Attachments",
  uploading: "Uploading file …",
  unsupportedSession: "Attachments are unavailable in this session.",
  tooManyFiles: "A message can have up to 8 attachments.",
  notAnImage: "Only image files can be attached.",
  fileTooLarge: "Files must not exceed 10 MiB.",
};
export const chatImagesCopy = {
  chatImageDialogAriaLabel: "Image viewer",
  chatImageDialogContentAriaLabel: "Close image viewer",
  missingImage: "Image no longer available.",
  chatImageOpenAriaLabel: (value1) => `Open image: ${value1}`,
  unavailableImage: "Image unavailable",
  chatImageUnavailableHint: "The image file could not be loaded.",
  chatImageExpand: "Enlarge ↗",
  chatImageRetry: "Reload image",
  chatImagesAriaLabel: "Images in this message",
};
export const chatMessageCopy = {
  chatToolLabel: "Tool activity",
  ariaLabel: "Your message",
  subtle: "[Image",
};
export const chatViewCopy = {
  chatMainAriaLabel: "Chat",
  hideTasks: "Hide tasks",
  showTasks: "Show tasks",
  tasksToggle: "☷ Tasks",
  changeConversation: "Switch conversation",
  terminalFallback: "Terminal ↗",
  terminalApprovals: "Approvals in terminal ↗",
  chatEmptyHeading: "Room for your next idea.",
  emptyConversationPrefix: "Your messages and replies from",
  emptyConversationSuffix: " will appear here.",
  chatNotice: "Loading conversation …",
};
export const conversationPickerCopy = {
  conversationScopeDescription:
    "Choose the conversation running in this session. Only conversations from this account in the same project are shown.",
  conversationPickerOption: "Loading conversations …",
  noConversationsDescription:
    "No conversations yet. Refresh the list after the first message.",
};
export const taskPanelCopy = {
  taskHeadingAriaLabel: "Close tasks",
  contentAriaLabel: "Task progress",
  tasksEmpty: "The CLI has not created any tasks yet.",
};
export const chatAttachmentCopy = {
  attachments: "Attachments",
  choose: "Choose files",
  add: "Add file",
  uploading: "Uploading file …",
  remove: (name) => `Remove attachment: ${name}`,
  tooLarge: "A file must not exceed 10 MB.",
  tooMany: "A message can have up to 10 attachments.",
  failed: "The file could not be uploaded.",
  tooLong: "The message with attachments is too long. Please shorten the text.",
  prompt: "Please consider these attached files:",
};

export const chatDeliveryCopy = {
  savedNotices: (count) => `Saved delivery notices (${count})`,
  savedNoticesHint:
    "These saved notices record handoff to the session. They do not confirm processing and are separate from the conversation history.",
  ariaLabel: "Message delivery",
  waiting: "Waiting for handoff",
  absent: "Waiting for handoff · not yet accepted by server",
  sending: "Handing off …",
  checking: "Checking delivery …",
  pending: "Handoff in progress …",
  "handed-off": "Handed off to session · processing not yet confirmed",
  uncertain: "Delivery uncertain",
  rejected: "Not handed off",
  uncertainHint:
    "Check the conversation or terminal first. Sending again may cause a duplicate.",
  disconnected: "No confirmation received. The message remains saved.",
  retry: "Retry handoff",
  check: "Check delivery",
  restore: "Restore as draft after checking",
  edit: "Edit message",
  dismiss: "Dismiss delivery status",
  prepareFailed:
    "The message could not be prepared. Please refresh your browser and try again; your draft is preserved.",
  lockUnavailable:
    "This browser does not support safe delivery management. Please update your browser.",
  storageFailed:
    "The local draft or delivery state could not be saved. Please free up storage; pending messages remain visible for review.",
  storageUnreadable:
    "The saved draft cannot be read. It has not been overwritten; sending remains disabled.",
  timeout:
    "No confirmation received in time. Delivery will be checked when reconnecting.",
};
