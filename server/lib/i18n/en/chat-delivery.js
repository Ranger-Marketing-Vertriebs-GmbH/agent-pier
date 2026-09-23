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
  rejected:
    "The input was rejected before the terminal handoff. Please check the session and pending approvals.",
  uncertain: "The terminal handoff is uncertain. Sending again may duplicate the input.",
};
