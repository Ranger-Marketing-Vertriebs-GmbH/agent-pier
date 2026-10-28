import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

// One IMAP connection per tool call, no pooling: routines run every few minutes at most.
const defaultTimeouts = Object.freeze({
  connection: 15_000,
  greeting: 15_000,
  socket: 60_000,
});

const errorKeys = Object.freeze({
  MAIL_AUTH_FAILED: "mailAuthFailed",
  MAIL_TLS_FAILED: "mailTlsFailed",
  MAIL_UNREACHABLE: "mailUnreachable",
  MAIL_TIMEOUT: "mailTimeout",
  MAIL_PROTOCOL: "mailProtocol",
  MAIL_PLAINTEXT_REFUSED: "mailPlaintextRefused",
  MAIL_NOT_FOUND: "mailNotFound",
  MAIL_SEARCH_UNSUPPORTED: "mailSearchUnsupported",
  MAIL_NO_TRASH: "mailNoTrash",
  MAIL_NO_ARCHIVE: "mailNoArchive",
  MAIL_NO_DRAFTS: "mailNoDrafts",
  MAIL_MOVE_UNSUPPORTED: "mailMoveUnsupported",
  MAIL_DRAFT_UNSUPPORTED: "mailDraftUnsupported",
  MAIL_ATTACHMENT_TOO_LARGE: "mailAttachmentTooLarge",
  MAIL_DRAFT_CHANGED: "mailDraftChanged",
  MAIL_TEXT_UNSUPPORTED: "mailTextUnsupported",
  MAIL_TEXT_FAILED: "mailTextFailed",
  MAIL_BUSY: "mailBusy",
});

const unreachableCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
]);
const timeoutCodes = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);
const tlsCodes = new Set([
  "ETLS",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "STARTTLS_INJECTION",
]);
const isTlsCode = (code) => tlsCodes.has(code) || /^(CERT_|ERR_TLS_|ERR_SSL_)/.test(code);

/**
 * A mail error carries a stable code and catalog key, never server text, for the
 * agent and the owner. A `cause` added later (unreadDraft) is kept for the server's
 * own log only; toolError hands an agent nothing but code and reason.
 */
export function mailError(code) {
  return Object.assign(new Error(code), { code, key: errorKeys[code] });
}

function isMailError(error) {
  return typeof error?.code === "string" && error.code.startsWith("MAIL_");
}

/** Maps an imapflow, nodemailer or socket error to one of the MAIL_* codes. */
export function mailErrorCode(error) {
  const codes = [error?.originalCode, error?.code, error?.cause?.code].filter(
    (code) => typeof code === "string",
  );
  if (error?.authenticationFailed || codes.includes("EAUTH")) return "MAIL_AUTH_FAILED";
  if (error?.tlsFailed || codes.some(isTlsCode)) return "MAIL_TLS_FAILED";
  if (codes.some((code) => timeoutCodes.has(code))) return "MAIL_TIMEOUT";
  if (codes.some((code) => unreachableCodes.has(code))) return "MAIL_UNREACHABLE";
  return "MAIL_PROTOCOL";
}

function asMailError(error) {
  return isMailError(error) ? error : mailError(mailErrorCode(error));
}

// Programming errors (a TypeError from a caller's bug, also Node's own ERR_INVALID_*
// TypeErrors) are never server answers and must surface unchanged.
const isProgrammingError = (error) =>
  error instanceof TypeError ||
  error instanceof RangeError ||
  error instanceof ReferenceError ||
  error instanceof SyntaxError;

// An error raised by imapflow, nodemailer, a socket or the server: these carry a
// status, a server response or a library/socket code.
function isTransportError(error) {
  if (!error || typeof error !== "object" || isProgrammingError(error)) return false;
  return Boolean(
    error.authenticationFailed ||
    error.tlsFailed ||
    error.responseStatus ||
    error.serverResponseCode ||
    error.response ||
    error.responseCode ||
    typeof error.code === "string",
  );
}

// Inside a caller's callback only transport errors become mail errors; anything else
// (a bug, an application error) is rethrown as is.
function translate(error) {
  return isMailError(error) || !isTransportError(error) ? error : asMailError(error);
}

const logoutLimit = 5_000;

// A server that stops answering must not hold the call: logout gets 5 s, then the
// socket is closed.
async function closeImap(client) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, logoutLimit, "timeout");
    timer.unref?.();
  });
  try {
    const result = await Promise.race([client.logout().then(() => "done"), limit]);
    if (result === "timeout") client.close();
  } catch {
    client.close();
  } finally {
    clearTimeout(timer);
  }
}

function transport(account, settings, { ca, timeouts } = {}) {
  const security = settings.security;
  if (!["tls", "starttls", "none"].includes(security))
    throw new TypeError("Unknown mail transport security.");
  if (security === "none" && account.allowPlaintext !== true)
    throw mailError("MAIL_PLAINTEXT_REFUSED");
  const limits = { ...defaultTimeouts, ...timeouts };
  return {
    security,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(ca ? { ca } : {}) },
    timeouts: {
      connectionTimeout: limits.connection,
      greetingTimeout: limits.greeting,
      socketTimeout: limits.socket,
    },
  };
}

/** ImapFlow options: certificate validation always on, STARTTLS mandatory, logging off. */
export function imapOptions(account, password, options) {
  const { security, tls, timeouts } = transport(account, account.imap, options);
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: security === "tls",
    ...(security === "tls" ? {} : { doSTARTTLS: security === "starttls" }),
    auth: { user: account.imap.username, pass: password },
    tls,
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    ...timeouts,
  };
}

/** Nodemailer SMTP options with the same TLS rules and timeouts as IMAP. */
export function smtpOptions(account, password, options) {
  const { security, tls, timeouts } = transport(account, account.smtp, options);
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    auth: { user: account.smtp.username || account.imap.username, pass: password },
    tls,
    logger: false,
    debug: false,
    ...timeouts,
  };
}

/** Connects, runs `fn` with the client and always closes the connection. */
export async function withImap(account, password, fn, options) {
  const client = new ImapFlow(imapOptions(account, password, options));
  // Without a listener a late socket error would crash the process.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw isProgrammingError(error) ? error : asMailError(error);
  }
  try {
    return await fn(client);
  } catch (error) {
    throw translate(error);
  } finally {
    await closeImap(client);
  }
}

async function withSmtp(account, password, fn, options) {
  const transporter = nodemailer.createTransport(smtpOptions(account, password, options));
  try {
    return await fn(transporter);
  } catch (error) {
    throw translate(error);
  } finally {
    transporter.close();
  }
}

/** Sends a composed message to exactly the given envelope. */
export async function smtpSend(account, password, { envelope, raw }, options) {
  return withSmtp(
    account,
    password,
    async (transporter) => {
      const info = await transporter.sendMail({
        envelope: { from: envelope.from, to: [...envelope.to] },
        raw,
      });
      return {
        accepted: info.accepted?.length ?? 0,
        rejected: info.rejected?.length ?? 0,
      };
    },
    options,
  );
}

async function outcome(run) {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    if (!isMailError(error)) throw error;
    return { ok: false, code: error.code };
  }
}

/** Checks login on both servers: IMAP login and folder list, SMTP verify. */
export async function testMailAccount(account, password, options) {
  const [imap, smtp] = await Promise.all([
    outcome(() => withImap(account, password, (client) => client.list(), options)),
    outcome(() => withSmtp(account, password, (t) => t.verify(), options)),
  ]);
  return { imap, smtp };
}
