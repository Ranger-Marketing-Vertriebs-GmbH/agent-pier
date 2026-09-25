export const chatComposerCopy = {
  requestPending:
    "Answer the open request above or in the terminal. Messages you send now are delivered afterwards.",
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
  oldNoNewline: "No final newline in previous content",
  newNoNewline: "No final newline in new content",
  changeCreate: "Create",
  changeUpdate: "Update",
  changeDelete: "Delete",
  changeRename: "Rename",
  changeWrite: "Write",
  changeFull: "File contents",
  changePatch: "Native patch",
  changeExcerpt: "Replacement excerpt",
  changePreview: "Content preview · previous content unknown",
  changeRaw: "Raw arguments and output",
  changeCode: "Code changes",
  expandOutput: "Show more lines",
  moreOutput: "Show more",
  collapseOutput: "Collapse to eight lines",

  agentWorking: "Agent is working",
  agentActivity: "Agent activity",
  toolCount: (count) => `${count} ${count === 1 ? "call" : "calls"}`,
  toolFailures: (count) => `${count} failed`,
  chatToolLabel: "Tool activity",
  toolDetails: "Details",
  ariaLabel: "Your message",
  subtle: "[Image",
};
export const chatViewCopy = {
  jumpToLatest: "Jump to latest",
  resetRequested: "New conversation requested",
  resetConfirmed: "New conversation ready",
  resetPrevious: "Previous conversation",
  resetPendingHint:
    "Waiting for Codex to confirm the new conversation. Your previous history remains available below.",
  historyOlder: "Load older messages",
  historyLoading: "Loading older messages …",
  historyRetry: "Retry older messages",
  historyFailed: "Older messages could not be loaded.",

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
  failed: "The file could not be uploaded.",
  tooLong: "The message with attachments is too long. Please shorten the text.",
  prompt: "Please consider these attached files:",
};

export const chatDeliveryCopy = {
  nativeQueued: "In the CLI queue",
  nativeAccepted: "Accepted by CLI",
  nativeCodexQueueHint:
    "Codex shows this message for submission after the next tool call.",
  nativeQueueHint: "The CLI shows this message as queued.",

  savedNotices: (count) => `Saved delivery notices (${count})`,
  savedNoticesHint:
    "These saved notices record handoff to the session. They do not confirm processing and are separate from the conversation history.",
  ariaLabel: "Message delivery",
  waiting: "Waiting for handoff",
  absent: "Waiting for handoff · not yet accepted by server",
  sending: "Handing off …",
  checking: "Checking delivery …",
  pending: "Handoff in progress …",
  "handed-off": "Sent to TUI · awaiting CLI confirmation",
  uncertain: "Delivery uncertain",
  waitingRequest:
    "Waiting for the open request to be answered · sent automatically afterwards",
  waitingDialog:
    "Waiting for a dialog in the TUI · sent automatically once it is answered or closed",
  waitingQueue: "Waiting behind an earlier message · sent automatically afterwards",
  cancel: "Cancel sending",
  rejected: "Not delivered",
  uncertainHint:
    "Redeliver first checks the terminal input. If the outcome remains unclear, nothing is written again.",
  disconnected: "No confirmation received. The message remains saved.",
  recovering: "Checking …",
  redeliver: "Deliver again",
  inspect: "Inspect handoff",
  openTerminal: "Open TUI",
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
  absentHint:
    "The server did not accept this message. You can edit it or retry the handoff.",
  // The same reasons after the text was pasted but before Enter (uncertain).
  imagesPasted:
    "The attached images are in the TUI prompt, but the message was not completed and not submitted. Check the TUI before sending again.",
  // The same reasons with only the image chips in the prompt (images-pasted).
  imagesPastedReasons: {
    CHAT_PROMPT_CHANGED:
      "The attached images were pasted into the CLI, but the prompt changed while the message waited, so it was not completed and not submitted. Please check the TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "The attached images are in the TUI prompt, but the message was not completed and not submitted: a CLI dialog is still open. Check the TUI before sending again.",
    CHAT_QUESTION_OPEN:
      "The attached images are in the TUI prompt, but the message was not completed and not submitted: Claude is waiting for an answer to a question. Check the TUI before sending again.",
    CHAT_REQUEST_PENDING:
      "The attached images are in the TUI prompt, but the message was not completed and not submitted: a request is waiting for an answer. Check the TUI before sending again.",
  },
  pastedReasons: {
    CHAT_PROMPT_CHANGED:
      "The message was pasted into the CLI, but the prompt changed while it waited, so it was not submitted. Please check the TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "The message is in the TUI prompt but was not submitted: a dialog is still open in the CLI. Check the TUI before sending again.",
    CHAT_QUESTION_OPEN:
      "The message is in the TUI prompt but was not submitted: Claude is waiting for an answer to a question. Check the TUI before sending again.",
    CHAT_REQUEST_PENDING:
      "The message is in the TUI prompt but was not submitted: a request is waiting for an answer. Check the TUI before sending again.",
    CHAT_COMPOSER_DIALOG:
      "The message was pasted into the CLI but not submitted: Claude is showing a dialog. Check the TUI before sending again.",
    CHAT_COMPOSER_UNAVAILABLE:
      "The message was pasted into the CLI but not submitted: its input field cannot be identified safely. Please check the TUI.",
    CHAT_COMPOSER_NOT_CLEARED:
      "The message was pasted into the CLI but not submitted. Check the TUI before sending again.",
    CHAT_IMAGES_UNCONFIRMED:
      "The message was pasted into the CLI but not submitted: the CLI's input field does not show all attached images. Enlarge the terminal or check the TUI before sending again.",
  },
  // Informational, non-blocking notes on a completed handoff.
  notices: {
    CHAT_APPENDED_TO_DRAFT:
      "Sent together with text that was already in the terminal prompt.",
    CHAT_PROMPT_UNREADABLE:
      "The terminal prompt could not be read; the message was sent together with anything it already contained.",
    CHAT_DIALOG_CLOSED:
      "An open Claude menu (such as rewind or the model picker) was closed with Esc before sending.",
    CHAT_IMAGES_MAYBE_MISSING:
      "The CLI did not show all attached images before sending; some images may be missing.",
  },
  reasons: {
    CHAT_PROMPT_CHANGED:
      "The message was pasted into the CLI, but the prompt changed while it waited, so it was not submitted. Please check the TUI.",
    CHAT_QUEUED:
      "The message was waiting behind an earlier message and has not been typed yet. Send it again.",
    CHAT_CANCELLED: "Cancelled before the message was typed into the TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "The message was waiting for a CLI dialog and has not been typed yet. Answer or close the dialog in the terminal, then send it again.",
    CHAT_QUESTION_OPEN:
      "The message was waiting for a question in the TUI to be answered and has not been typed yet. Answer it in the terminal, then send it again.",
    CHAT_REQUEST_PENDING:
      "The message was waiting for an open request to be answered and has not been typed yet. Send it again once the request is answered.",
    CHAT_COMPOSER_DIALOG:
      "Claude is showing a dialog or picker. The message was not sent; answer or close the dialog in the TUI.",
    CHAT_COMPOSER_UNAVAILABLE:
      "Claude's input field cannot be identified safely. The message was not sent; please check the TUI.",
    CHAT_COMPOSER_NOT_CLEARED:
      "The existing draft in Claude's input field could not be replaced safely. The message was not sent; please check the TUI.",
    CHAT_SUBMIT_UNCONFIRMED:
      "The CLI did not confirm that it accepted the message. Check the TUI before sending again.",
    CHAT_IMAGES_UNCONFIRMED:
      "The CLI did not confirm that all attached images were accepted. Check the TUI before sending again.",
  },
};
