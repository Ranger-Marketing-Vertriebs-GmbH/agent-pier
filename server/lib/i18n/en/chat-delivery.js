export const chatDeliveryCopy = {
  recoveryUncertain:
    "It cannot be reliably determined whether the message was already sent. Please check the TUI.",
  recoveryLimit: "Too many recovery attempts for this message. Please check the TUI.",
  recoveryPending: "A handoff attempt is already in progress.",
  recoveryChanged:
    "The delivery state has changed in the meantime. Please refresh the status.",
  recoveryRuntime:
    "The original CLI session can no longer be identified unambiguously. Please check the TUI.",
  recoveryComposer:
    "The TUI input contains different text or cannot be read completely. It was not changed.",
  recoveryReadySubmit:
    'The full text is still in the TUI. "Deliver again" only completes the submission.',
  recoveryReadyResend: "The message has not been written yet and can be delivered again.",
  recoveryHandedOff: "The message was handed off to the TUI.",
  invalid: "Invalid delivery request.",
  scope: "The delivery request does not belong to the current session.",
  conflict: "This delivery ID was already used for a different request.",
  storage: "The delivery receipt cannot be saved or read safely.",
  cancelPasted: "The message is already in the TUI prompt. Remove or send it there.",
  recoveryHeld: "The message is waiting and will be delivered once the TUI is free.",
  rejected:
    "The input was rejected before the terminal handoff. Please check the session and pending approvals.",
  uncertain: "The terminal handoff is uncertain. Sending again may duplicate the input.",
  // The same reasons after the text was pasted but before Enter (uncertain).
  pastedReasons: {
    CHAT_PROMPT_CHANGED:
      "The message was pasted into Claude, but the prompt changed while it waited, so it was not submitted. Please check the TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "The message is in the TUI prompt but was not submitted: a Claude menu could not be closed. Check the TUI before sending again.",
    CHAT_QUESTION_OPEN:
      "The message is in the TUI prompt but was not submitted: Claude is waiting for an answer to a question. Check the TUI before sending again.",
    CHAT_REQUEST_PENDING:
      "The message is in the TUI prompt but was not submitted: a request is waiting for an answer. Check the TUI before sending again.",
    CHAT_COMPOSER_DIALOG:
      "The message was pasted into Claude but not submitted: Claude is showing a dialog. Check the TUI before sending again.",
    CHAT_COMPOSER_UNAVAILABLE:
      "The message was pasted into Claude but not submitted: its input field cannot be identified safely. Please check the TUI.",
    CHAT_COMPOSER_NOT_CLEARED:
      "The message was pasted into Claude but not submitted. Check the TUI before sending again.",
    CHAT_IMAGES_UNCONFIRMED:
      "The message was pasted into Claude but not submitted: Claude's input field does not show all attached images. Enlarge the terminal or check the TUI before sending again.",
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
      "Claude did not show all attached images before sending; some images may be missing.",
  },
  reasons: {
    CHAT_PROMPT_CHANGED:
      "The message was pasted into Claude, but the prompt changed while it waited, so it was not submitted. Please check the TUI.",
    CHAT_QUEUED:
      "The message was waiting behind an earlier message and has not been typed yet. Send it again.",
    CHAT_CANCELLED: "Cancelled before the message was typed into the TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "The message was waiting for a Claude menu to close and has not been typed yet. Close the menu in the terminal, then send it again.",
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
      "Claude did not confirm that it accepted the message. Check the TUI before sending again.",
    CHAT_IMAGES_UNCONFIRMED:
      "Claude did not confirm that all attached images were accepted. Check the TUI before sending again.",
  },
};
