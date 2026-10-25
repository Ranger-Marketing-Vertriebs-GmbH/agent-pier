import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { readJSON, writePrivate } from "../../lib/storage.js";

/** Longest diagnostic line a stored test result keeps. */
export const testDetailLimit = 200;
const resultsFile = "test-results.json";
const identifier = /^[0-9a-f-]{36}$/;
const hexDigest = /^[0-9a-f]{64}$/;
// OpenSSH's own words for a host key that no longer matches the pinned one.
const hostKeyChanged =
  /host key verification failed|remote host identification has changed/i;
// Lines OpenSSH prints on every run that say nothing about the failure.
const noise = /^(?:warning: permanently added|pseudo-terminal will not be allocated)/i;

const redactions = [
  // Private or public key material and certificates.
  [/-----BEGIN [^-]*-----[\s\S]*?(?:-----END [^-]*-----|$)/g, "[redacted]"],
  [
    /\b((?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+)(?:-cert-v01@openssh\.com)?)\s+[A-Za-z0-9+/=]{16,}/gi,
    "$1 [redacted]",
  ],
  // Credentials in URLs, headers and key=value pairs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@"],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2[redacted]",
  ],
  // Well-known token shapes and any long opaque value.
  [
    /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abpr]-|sk-|aph_)[A-Za-z0-9_-]{8,}/g,
    "[redacted]",
  ],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]"],
];

/**
 * One diagnostic line of a failed connection test for the owner's list: the last
 * meaningful line of OpenSSH's stderr (or the SFTP client's problem code), with key
 * material, credentials and opaque tokens removed and control characters dropped,
 * at most `testDetailLimit` characters. Native diagnostics keep their language.
 */
export function sanitizeTestDetail(text) {
  if (typeof text !== "string" || !text) return null;
  let clean = text;
  for (const [pattern, replacement] of redactions)
    clean = clean.replace(pattern, replacement);
  const line = clean
    .split(/\r?\n/)
    .map((row) => row.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim())
    .filter((row) => row && !noise.test(row))
    .at(-1);
  if (!line) return null;
  const single = line.replace(/\s+/g, " ");
  return single.length > testDetailLimit
    ? `${single.slice(0, testDetailLimit - 1)}…`
    : single;
}

/**
 * `error` (the test's 502 problem) carrying its outcome for SshAccessStore.test, with
 * the detail already sanitized and the property hidden from serialization and logs.
 */
export function withTestOutcome(error, { code = null, hostKeyMismatch = false, detail }) {
  return Object.defineProperty(error, "testOutcome", {
    value: {
      ok: false,
      code,
      hostKeyMismatch: hostKeyMismatch === true,
      detail: sanitizeTestDetail(detail),
    },
    enumerable: false,
  });
}

/** Whether OpenSSH's stderr reports a changed host key. */
export const reportsHostKeyChange = (text) =>
  typeof text === "string" && hostKeyChanged.test(text);

/**
 * The last connection test of each SSH/SFTP host (docs/ssh-access.md), kept apart from
 * the SSH catalog so a test never writes the catalog or its revisions. Each entry
 * carries the host's connection revision at test time; once the endpoint, key or
 * credential changes, the old result no longer describes the host and reads as
 * untested. Backups leave the file out (they never carry SSH hosts' state).
 */
export class SshTestResults {
  constructor({ root }) {
    this.file = path.join(root, resultsFile);
  }
  read() {
    try {
      const saved = readJSON(this.file, null);
      return saved?.version === 1 && saved.results && typeof saved.results === "object"
        ? saved.results
        : {};
    } catch {
      return {};
    }
  }
  /** Saves the outcome; a write failure never fails the test itself. */
  record(id, revision, outcome) {
    if (!identifier.test(id) || !hexDigest.test(revision)) return;
    const entry = {
      ok: outcome.ok === true,
      at: new Date().toISOString(),
      revision,
      ...(outcome.ok
        ? { commandRejected: outcome.commandRejected === true }
        : {
            code: typeof outcome.code === "string" ? outcome.code : null,
            hostKeyMismatch: outcome.hostKeyMismatch === true,
            detail: sanitizeTestDetail(outcome.detail),
          }),
    };
    try {
      writePrivate(this.file, { version: 1, results: { ...this.read(), [id]: entry } });
    } catch {
      /* The answer of the test stands; the list shows the previous result. */
    }
  }
  forget(id) {
    const results = this.read();
    if (!Object.hasOwn(results, id)) return;
    delete results[id];
    try {
      writePrivate(this.file, { version: 1, results });
    } catch {
      /* A stale entry of a removed host is never shown (no host lists it). */
    }
  }
  /** The public view of a host's last test, or null when untested since its change. */
  view(results, id, revision) {
    const entry = Object.hasOwn(results, id) ? results[id] : null;
    if (!entry || entry.revision !== revision || typeof entry.at !== "string")
      return null;
    if (entry.ok === true)
      return {
        ok: true,
        at: entry.at,
        commandRejected: entry.commandRejected === true,
        code: null,
        hostKeyMismatch: false,
        detail: null,
        error: null,
      };
    const message = serverMessages.ssh.connectionFailed;
    return {
      ok: false,
      at: entry.at,
      commandRejected: false,
      code: typeof entry.code === "string" ? entry.code : null,
      hostKeyMismatch: entry.hostKeyMismatch === true,
      // Sanitized again on read: a hand-edited file never reaches the browser raw.
      detail: sanitizeTestDetail(entry.detail),
      error: message,
      ...messageIdentity(message),
    };
  }
}
