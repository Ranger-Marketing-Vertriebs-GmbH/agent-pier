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
});
