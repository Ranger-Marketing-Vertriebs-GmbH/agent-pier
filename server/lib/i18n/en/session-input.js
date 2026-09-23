/** English counterpart of de/session-input.js with identical keys. */
export const sessionInput = Object.freeze({
  invalid: "Invalid chat input",
  controlCharacters: "Chat input contains terminal control characters",
  composerDraft: "The terminal composer already contains a draft",
  composerUninspectable: "The terminal composer cannot be safely inspected",
  composerConflict: "The terminal composer conflicts with this chat input",
  unsupported: "This session does not support chat input",
  launchIdentityInvalid: "Native session launch identity is missing or invalid",
  launchIdentityChanged: "Native session launch identity changed",
  receiptInvalid: "Native session receipt is invalid",
  identityChanged: "Native session identity changed",
  processChanged: "Native session process changed",
  terminalIdentityUninspectable: "The terminal identity cannot be safely inspected",
  transactionEnded: "Chat input transaction has ended",
  generationChanged: "Session generation changed",
  alreadyAttempted: "Chat input was already attempted",
  imagesUninspectable: "Claude's existing image attachments cannot be inspected",
});
