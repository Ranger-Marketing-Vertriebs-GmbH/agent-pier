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

/** A mail error carries only a stable code and catalog key, never server text. */
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
    doSTARTTLS: security === "starttls" ? true : security === "none" ? false : undefined,
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
    throw asMailError(error);
  }
  try {
    return await fn(client);
  } catch (error) {
    throw asMailError(error);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function withSmtp(account, password, fn, options) {
  const transporter = nodemailer.createTransport(smtpOptions(account, password, options));
  try {
    return await fn(transporter);
  } catch (error) {
    throw asMailError(error);
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
    return { ok: false, code: asMailError(error).code };
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
