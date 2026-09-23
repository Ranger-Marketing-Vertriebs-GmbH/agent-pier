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
  recoveryReadyText:
    'The images are still in the TUI. "Deliver again" only adds the text and submits the message.',
  recoveryReadyResend: "The message has not been written yet and can be delivered again.",
  recoveryHandedOff: "The message was handed off to the TUI.",
  invalid: "Invalid delivery request.",
  scope: "The delivery request does not belong to the current session.",
  conflict: "This delivery ID was already used for a different request.",
  storage: "The delivery receipt cannot be saved or read safely.",
  rejected:
    "The input was rejected before the terminal handoff. Please check the session and pending approvals.",
  uncertain: "The terminal handoff is uncertain. Sending again may duplicate the input.",
  // The same reasons after the text was pasted but before Enter (uncertain).
  pastedReasons: {
    CHAT_COMPOSER_DIALOG:
      "The message was pasted into Claude but not submitted: Claude is showing a dialog. Check the TUI before sending again.",
    CHAT_COMPOSER_UNAVAILABLE:
      "The message was pasted into Claude but not submitted: its input field cannot be identified safely. Please check the TUI.",
    CHAT_COMPOSER_NOT_CLEARED:
      "The message was pasted into Claude but not submitted. Check the TUI before sending again.",
    CHAT_IMAGES_UNCONFIRMED:
      "The message was not submitted: Claude's input field does not show all attached images. Check the TUI before sending again.",
  },
  reasons: {
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
