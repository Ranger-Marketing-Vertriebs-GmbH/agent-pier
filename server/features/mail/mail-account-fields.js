import net from "node:net";
import addressparser from "nodemailer/lib/addressparser";
import { serverMessages } from "../../lib/i18n/de.js";
import { nameValue, problem } from "../../lib/storage.js";
import { passwordValue } from "../ssh/ssh-password-store.js";

const securities = ["tls", "starttls", "none"];
/** The keys an account body may carry (create, update and test). */
export const accountInputKeys = Object.freeze([
  "name",
  "address",
  "displayName",
  "preset",
  "imap",
  "smtp",
  "allowPlaintext",
  "saveSent",
  "password",
]);
const accountKeys = new Set(accountInputKeys);
/** Every field of a stored catalog row; a backup restores exactly these. */
export const accountRowKeys = Object.freeze([
  "id",
  "name",
  "address",
  "displayName",
  "preset",
  "imap",
  "smtp",
  "allowPlaintext",
  "saveSent",
  "credentialRevision",
  "createdAt",
  "updatedAt",
  "lastTest",
]);
const serverKeys = new Set(["host", "port", "security", "username"]);

/** Starting values of the account form; a missing server field takes the preset's. */
export const mailPresets = Object.freeze({
  gmail: Object.freeze({
    imap: Object.freeze({ host: "imap.gmail.com", port: 993, security: "tls" }),
    smtp: Object.freeze({ host: "smtp.gmail.com", port: 465, security: "tls" }),
    // Gmail files every SMTP send in Sent itself.
    saveSent: false,
  }),
  generic: Object.freeze({
    imap: Object.freeze({ port: 993, security: "tls" }),
    smtp: Object.freeze({ port: 465, security: "tls" }),
    saveSent: true,
  }),
});

const invalid = () => problem(serverMessages.mail.invalidAccount);
const isObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const hostLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function hostValue(value) {
  if (typeof value !== "string") throw invalid();
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253) throw invalid();
  if (net.isIP(host)) return host;
  const labels = host.replace(/\.$/, "").split(".");
  if (!labels.every((label) => hostLabel.test(label))) throw invalid();
  return host;
}

function portValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw invalid();
  return value;
}

function textValue(value, max) {
  if (typeof value !== "string") throw invalid();
  const text = value.trim();
  if (text.length > max || unsafe.test(text)) throw invalid();
  return text;
}

/** One plain addr-spec (`local@domain`), never a display name, group or list. */
export function addressValue(value) {
  if (typeof value !== "string") throw invalid();
  const address = value.trim();
  if (!address || address.length > 320 || unsafe.test(address) || /\s/.test(address))
    throw invalid();
  const parsed = addressparser(address);
  if (
    parsed.length !== 1 ||
    parsed[0].group ||
    parsed[0].name ||
    parsed[0].address !== address
  )
    throw invalid();
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) throw invalid();
  return address;
}

function booleanValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid();
  return value;
}

function serverValue(raw, preset, existing, defaultUsername) {
  if (raw !== undefined && !isObject(raw)) throw invalid();
  const input = raw ?? {};
  if (Object.keys(input).some((key) => !serverKeys.has(key))) throw invalid();
  const merged = { ...preset, ...existing, ...input };
  if (!securities.includes(merged.security)) throw invalid();
  const username =
    merged.username === undefined || merged.username === ""
      ? defaultUsername
      : textValue(merged.username, 320);
  if (!username) throw invalid();
  return {
    host: hostValue(merged.host),
    port: portValue(merged.port),
    security: merged.security,
    username,
  };
}

const endpoint = ({ host, port, security }) => JSON.stringify([host, port, security]);

/** Whether `fields` reach the same IMAP and SMTP servers as `existing`. */
export function sameEndpoints(existing, fields) {
  return ["imap", "smtp"].every(
    (side) => endpoint(existing[side]) === endpoint(fields[side]),
  );
}

/**
 * The validated fields of a new account, or of `existing` changed by `raw`. Server
 * fields merge per field (preset < existing < input). `password` is only present
 * when given; a new account needs one unless `requirePassword` is false. A saved
 * password is bound to its servers: changing an IMAP or SMTP host, port or security
 * (also through the preset) of `existing` needs a new password.
 */
export function accountInput(raw, { existing, requirePassword = !existing } = {}) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !accountKeys.has(key)))
    throw invalid();
  const base = existing ?? {};
  const preset = raw.preset ?? base.preset ?? "generic";
  if (!Object.hasOwn(mailPresets, preset)) throw invalid();
  const defaults = mailPresets[preset];
  const address = addressValue(raw.address ?? base.address);
  // A changed preset starts from its own servers, not the previous preset's.
  const keep = raw.preset === undefined || raw.preset === base.preset;
  const imap = serverValue(raw.imap, defaults.imap, keep ? base.imap : {}, address);
  const smtp = serverValue(raw.smtp, defaults.smtp, keep ? base.smtp : {}, imap.username);
  const fields = {
    name: nameValue(raw.name ?? base.name),
    address,
    displayName: textValue(raw.displayName ?? base.displayName ?? "", 100),
    preset,
    imap,
    smtp,
    allowPlaintext: booleanValue(raw.allowPlaintext, base.allowPlaintext ?? false),
    saveSent: booleanValue(raw.saveSent, base.saveSent ?? defaults.saveSent),
  };
  if (
    (imap.security === "none" || smtp.security === "none") &&
    fields.allowPlaintext !== true
  )
    throw problem(serverMessages.mail.plaintextNeedsConsent);
  if (raw.password !== undefined)
    fields.password = passwordValue(raw.password, serverMessages.mail.invalidPassword);
  else if (requirePassword) throw problem(serverMessages.mail.invalidPassword);
  else if (existing && !sameEndpoints(existing, fields))
    throw problem(serverMessages.mail.passwordRequiredForServer);
  return fields;
}
