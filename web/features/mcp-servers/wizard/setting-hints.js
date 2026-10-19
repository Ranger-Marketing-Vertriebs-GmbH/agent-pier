import { hasPlaceholderCandidate, placeholderInvalid } from "../agent-placeholders.js";
import { hasReference } from "./value-references.js";

// Masking only (Q3): a secret-looking name hides its value while typing; every value
// is write-only after the save regardless.
const secretPattern = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE/i;
const writePattern = /ALLOW_WRITES|READ_?ONLY|READWRITE|WRITE_ENABLED/i;
const readOnlyPattern = /READ_?ONLY/i;
// The server's rules (server/features/extensions/mcp-config.js `values`).
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reservedNames = new Set(["__proto__", "constructor", "prototype"]);
const valueLimit = 16384;
const falsy = new Set(["", "0", "false", "no", "off"]);
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const tokenParameter = /token|key|secret|auth|password|passwd|sig|credential/i;

export const isSecretName = (name) => secretPattern.test(String(name ?? ""));

/**
 * The per-setting hints of a draft. The package step can drop a directory entry's
 * hints (`useDirectory: false`); paste hints never set that flag.
 */
export const settingHints = (hints = {}) =>
  hints.useDirectory === false ? {} : (hints.settings ?? {});

export const isWriteSwitch = (name, description = "") =>
  writePattern.test(String(name ?? "")) || writePattern.test(String(description ?? ""));

/**
 * The first setting that decides about writes, with what the owner typed: a
 * read-only switch reads inverted; a stored value nobody replaced is unreadable.
 */
export function writeSwitch(rows, { hints = {} } = {}) {
  const found = rows.find(
    (row) =>
      row.name &&
      !row.removed &&
      isWriteSwitch(row.name, settingHints(hints)[row.name]?.description),
  );
  if (!found) return null;
  if (found.stored && !found.value) return { name: found.name, state: "stored" };
  const off = falsy.has(String(found.value).trim().toLowerCase());
  const inverted = readOnlyPattern.test(found.name);
  return { name: found.name, state: off !== inverted ? "off" : "on" };
}

/** Why a setting row cannot be saved as typed, or null. Empty new rows are ignored. */
export function settingProblem(row, { kind, required = false, rows = [] }) {
  const name = row.name.trim();
  if (!name && !row.value) return null;
  if (!(kind === "header" ? headerName : envName).test(name) || reservedNames.has(name))
    return kind === "header" ? "headerName" : "envName";
  if (rows.some((other) => other.key !== row.key && other.name.trim() === name))
    return "duplicate";
  if (row.removed) return null;
  if (!row.value) return required && !row.stored ? "requiredEmpty" : null;
  if (row.value.length > valueLimit) return "tooLong";
  if (/[\0\r\n]/.test(row.value)) return "lineBreak";
  if (hasReference(row.value)) return "reference";
  // Agent placeholders: valid in a local server's environment, nowhere in headers.
  if (kind === "header" && hasPlaceholderCandidate(row.value)) return "placeholderRemote";
  if (kind === "env" && placeholderInvalid(row.value)) return "placeholder";
  return null;
}

/** Warnings for a typed address: unencrypted to another host, a token in the query. */
export function addressWarnings(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return [];
  }
  const warnings = [];
  if (url.protocol === "http:" && !loopback.has(url.hostname)) warnings.push("insecure");
  if ([...url.searchParams.keys()].some((key) => tokenParameter.test(key)))
    warnings.push("tokenInQuery");
  return warnings;
}

const kept = (row) => row.name.trim() && !row.removed && (row.value || row.stored);
/** Settings the server will hold after the save. */
export const storedCount = (rows) => rows.filter(kept).length;
/** Of those, the ones masked as secret (directory marker or name heuristic). */
export const secretCount = (rows, hints = {}) =>
  rows.filter(
    (row) =>
      kept(row) && (settingHints(hints)[row.name]?.secret || isSecretName(row.name)),
  ).length;
