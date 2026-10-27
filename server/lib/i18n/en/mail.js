/** Owner-facing copy of agents' email accounts (route problems and tool errors). */
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
  mailAttachmentsUnsupported: "A draft with attachments cannot be sent by an agent.",
  mailApprovalLimit: "Too many of the agent's emails already wait for your approval.",
  mailSendLimit: "The agent sent the most emails allowed in one hour.",
  mailRevoked: "The agent's access to this email account was changed.",
  mailQueryEmpty: "A mail search needs at least one criterion.",
  mailSearchUnsupported:
    "The mail server cannot search for text with non-ASCII characters.",
});
