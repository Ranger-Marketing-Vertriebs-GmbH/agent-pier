import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { privateDirectory, writePrivateText } from "../../lib/storage.js";

// No 0/O or 1/I, so the code survives being read off a terminal and typed on a phone.
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const shape = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const digest = (value) => createHash("sha256").update(value).digest();

/** Twelve characters in three groups: 60 bits, far beyond what the attempt limits allow. */
function newCode() {
  const letters = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]);
  return [0, 4, 8].map((start) => letters.slice(start, start + 4).join("")).join("-");
}

/** What a person typed, in the stored form: any case, spaces or hyphens anywhere. */
const typed = (value) =>
  typeof value === "string" && value.length <= 64
    ? value
        .toUpperCase()
        .replace(/[\s-]/g, "")
        .replace(/(.{4})(?=.)/g, "$1-")
    : "";

export const setupCodeFile = (dataDir) => path.join(dataDir, "login", "setup-code");

/**
 * The one-time code that proves access to the AgentPier computer while its owner is
 * created over the plain network. It lives in a file only the service's own user can
 * read (`npm run setup-code` prints it) and goes once an owner exists. The file is read
 * on every use, so a code the command created is the one the running service checks.
 */
export class SetupCode {
  constructor({ dataDir }) {
    this.file = setupCodeFile(dataDir);
  }
  /** The stored code, or null when none was created yet. */
  read() {
    try {
      const code = fs.readFileSync(this.file, "utf8").trim();
      return shape.test(code) ? code : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  /** The code to show the person at the computer, created on first use. */
  current() {
    const stored = this.read();
    if (stored) return stored;
    const code = newCode();
    privateDirectory(path.dirname(this.file));
    writePrivateText(this.file, code + "\n");
    return code;
  }
  matches(value) {
    const stored = this.read();
    const given = typed(value);
    // Digests have one length, so the comparison leaks neither length nor content.
    return Boolean(stored) && timingSafeEqual(digest(given), digest(stored));
  }
  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

/**
 * At service start: the code to print when the owner can be created over the plain
 * network right now, else null. A code left over from before an owner existed goes.
 */
export function startupSetupCode({ setupCode, configured, hasUsers, networkEnabled }) {
  if (configured) {
    setupCode.clear();
    return null;
  }
  return networkEnabled && !hasUsers ? setupCode.current() : null;
}
