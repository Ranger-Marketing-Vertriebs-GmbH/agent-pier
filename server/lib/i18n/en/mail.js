/** Owner-facing copy of agents' email accounts (route problems, tool errors, Telegram). */
export const mail = Object.freeze({
  mailAuthFailed: "The mail server refused the login. Check the username and password.",
  mailTlsFailed:
    "The encrypted connection to the mail server failed: the certificate is invalid or the server does not offer TLS.",
  mailUnreachable: "The mail server cannot be reached. Check the host and port.",
  mailTimeout: "The mail server did not answer in time.",
  mailProtocol: "The mail server sent an unexpected response.",
  mailPlaintextRefused: "Unencrypted connections are not allowed for this account.",
  accountNotFound: "Email account not found.",
  invalidAccount:
    "Invalid email account. Check name, address, hosts, ports and security.",
  plaintextNeedsConsent:
    "An unencrypted connection needs the explicit permission on the account.",
  passwordUnavailable: "The saved email password is unavailable.",
  invalidPassword: "The password must be 1 to 1024 bytes long without line breaks.",
  passwordRequiredForServer:
    "Enter the password again when you change a mail server, port or security.",
  catalogUnreadable: "The saved email accounts cannot be read.",
  testRateLimited: "Too many email connection tests. Try again in a minute.",
  mailAccountUnavailable:
    "This email account no longer exists. Reload the page and choose again.",
  telegramSendersMail:
    "An agent with its own Telegram bot for other people cannot have email access. Remove the email access or disconnect the bot first.",
  mailNotGranted: "The agent has no access to this email account.",
  mailSendNotGranted: "The agent may only read this email account, not send from it.",
  mailOriginRefused:
    "Email is only available in your own requests, routines and hooks with the Email tick.",
  mailNotFound: "The message or folder was not found.",
  mailNoTrash: "This mailbox has no Trash folder, so nothing was deleted.",
  mailNoArchive: "This mailbox has no archive folder, so nothing was moved.",
  mailNoDrafts: "This mailbox has no Drafts folder, so no draft was saved.",
  mailApprovalLimit: "Too many of the agent's emails already wait for your approval.",
  mailSendLimit: "The agent sent the most emails allowed in one hour.",
  mailRevoked: "The agent's access to this email account was changed.",
  mailQueryEmpty: "A mail search needs at least one criterion.",
  mailSearchUnsupported:
    "The mail server cannot search for text with non-ASCII characters.",
  mailDraftUnsupported:
    "An agent can only send a draft with plain text of at most 1 MiB; HTML parts are not sent.",
  mailMoveUnsupported:
    "The mail server does not support moving messages, so nothing was moved or deleted.",
  mailAttachmentTooLarge:
    "The attachments are larger than 25 MB, so nothing was saved or sent.",
  mailDraftChanged:
    "The draft changed in the mailbox after it was captured, so nothing was sent. The draft is kept.",
  mailTextUnsupported:
    "Text can only be read from PDF, Word, Excel, PowerPoint, text and CSV attachments.",
  mailTextFailed:
    "The attachment's text could not be read: the file is damaged, encrypted or too complex.",
  mailBusy: "AgentPier is reading other email right now. Try again in a moment.",
  mailSourceRefused: "The agent may not attach or save this file.",
  mailSourceNotFound: "The file to attach was not found.",
  mailSourceEmpty: "The file to attach is empty or not a regular file.",
  mailSaveRefused:
    "The agent may not save the attachment there. It may only save under mail/ in its workspace or in a project folder it may write to.",
  mailApproval: "Your agent wants to send an email:",
  mailSend: "Send",
  mailDecline: "Don't send",
  mailOpenToApprove: "Open AgentPier to read and approve this email.",
  mailAgent: (name) => `Agent: ${name}`,
  mailAccount: (name) => `Email account: ${name}`,
  mailFields: {
    from: "From",
    to: "To",
    cc: "Cc",
    bcc: "Bcc",
    subject: "Subject",
    forwardOf: "Forward of",
    attachment: "Attachment",
    inDraft: "Already in the draft",
    fromOriginal: "From the original mail",
    fromAgentDraft: (agent) => `from ${agent}'s draft`,
    unnamed: "(no name)",
  },
  mailHtmlKept: "Includes the original's HTML version, which is not shown here.",
  mailHtmlOmitted: "The original's HTML version is left out; only the text is forwarded.",
  mailHtmlDraft: "Includes an HTML version, which is not shown here.",
  mailStates: {
    completed: "Email sent",
    declined: "Email not sent — draft kept",
    expired: "Approval expired — draft kept",
    cancelled: "Email cancelled; the access changed",
    failed: "Sending failed; the draft is kept",
    unknown:
      "Not known whether the email went out; check the Sent folder before sending again",
  },
});
