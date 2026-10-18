import path from "node:path";
import { createHash } from "node:crypto";
import {
  BLOB_LENGTH,
  CREDENTIAL_DISTANCE,
  blobIndex,
  credentialPattern,
  downloadExecPatterns,
  hiddenCharacter,
  injectionPatterns,
  machineCode,
  networkPattern,
} from "./skill-scan-rules.js";

/**
 * The offline content scan of a skill before it is installed. It reads the unpacked
 * files only: nothing runs, nothing is fetched and nothing encoded is decoded. Skill
 * imports (zip, SKILL.md, GitHub) use it today; plugin and ClawHub installs can pass
 * their unpacked files the same way.
 */

/** Rule ids, in the order the preview lists them; the UI translates each one. */
export const SCAN_RULES = Object.freeze([
  "download-exec",
  "credential-exfiltration",
  "bidi-control",
  "unicode-tag",
  "invisible-character",
  "prompt-injection",
  "encoded-blob",
  "executable-file",
  "binary-executable",
]);
export const SCAN_VERDICTS = Object.freeze(["ok", "warn", "block"]);
export const SCAN_LIMITS = Object.freeze({
  blobLength: BLOB_LENGTH,
  credentialDistance: CREDENTIAL_DISTANCE,
  findingsPerRule: 5,
  findings: 200,
  excerpt: 120,
});

// Text an agent reads as instructions: hidden characters there block the install.
const instructionText = (name) => /\.(?:md|mdx|markdown|txt)$/i.test(name);
const markdown = (name) => /\.(?:md|mdx|markdown)$/i.test(name);
const referencePattern =
  /(?:\]\(\s*<?|`|^|[\s"'(])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|mdx|markdown|txt))\b/gimu;

/**
 * The documents SKILL.md points to (links, code spans or plain relative paths): the
 * agent follows them as instructions, so they count like SKILL.md itself.
 */
function followedDocuments(files) {
  const skill = files.find((file) => file.name === "SKILL.md");
  if (!skill) return new Set();
  const followed = new Set(["SKILL.md"]);
  for (const found of skill.data.toString("utf8").matchAll(referencePattern)) {
    const name = path.posix.normalize(found[1]);
    if (!name.startsWith("../")) followed.add(name);
  }
  return followed;
}
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Text with every control, format, private-use and invisible character written as
 * `<U+XXXX>`, so an excerpt shows what it hides and cannot reorder its display.
 */
export function visibleText(text) {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Co}\u2028\u2029\u{E0100}-\u{E01EF}\uFE00-\uFE0E]/gu,
    (char) =>
      char === "\t"
        ? char
        : `<U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/** About SCAN_LIMITS.excerpt characters of `line` around code unit `index`. */
function excerpt(line, index = 0) {
  const points = Array.from(line);
  let at = Array.from(line.slice(0, Math.max(0, index))).length;
  const start = Math.max(0, Math.min(at - 40, points.length - SCAN_LIMITS.excerpt));
  at = start + SCAN_LIMITS.excerpt;
  const text = points.slice(start, at).join("").trim();
  return visibleText(`${start > 0 ? "…" : ""}${text}${at < points.length ? "…" : ""}`);
}

/** `[name, data, mode]` (skill packs) or `{ name, data, mode }`, as one shape. */
function normalize(file) {
  const [name, data, mode = 0o600] = Array.isArray(file)
    ? file
    : [file.name, file.data, file.mode];
  return { name, data: Buffer.isBuffer(data) ? data : Buffer.from(data ?? ""), mode };
}

/** The text of a file, or null for binary content (a NUL byte). */
function readText(data) {
  if (data.includes(0)) return null;
  try {
    return { text: decoder.decode(data), unicode: true };
  } catch {
    // Not UTF-8: patterns still apply, character rules do not.
    return { text: data.toString("latin1"), unicode: false };
  }
}

function scanText(file, { text, unicode }, add, followed) {
  const lines = text.split(/\r?\n/);
  const instructions = instructionText(file.name);
  const credentials = [];
  const network = [];
  let logical = "";
  let logicalStart = 0;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (unicode) {
      const chars = Array.from(line);
      const points = chars.map((char) => char.codePointAt(0));
      const hidden = hiddenCharacter(points, { fileStart: index === 0 });
      if (hidden)
        add(hidden.rule, instructions ? "block" : "warn", number, {
          line,
          index: chars.slice(0, hidden.index).join("").length,
        });
    }
    if (instructions)
      for (const pattern of injectionPatterns) {
        const found = pattern.exec(line);
        if (found) {
          add("prompt-injection", "warn", number, { line, index: found.index });
          break;
        }
      }
    const blob = blobIndex(line);
    if (blob >= 0) add("encoded-blob", "warn", number, { line, index: blob });
    const credential = credentialPattern.exec(line);
    if (credential) credentials.push({ number, line, index: credential.index });
    const call = networkPattern.exec(line);
    if (call) network.push({ number, line, index: call.index });
    // Shell continuations: a pipeline split over lines is read as one.
    if (!logical) logicalStart = number;
    logical += line;
    if (line.endsWith("\\")) {
      logical = logical.slice(0, -1);
      return;
    }
    for (const pattern of downloadExecPatterns) {
      const found = pattern.exec(logical);
      if (found) {
        // README-style docs often show such installs; only what the agent runs or
        // follows as instructions blocks.
        const severity =
          !instructionText(file.name) || followed.has(file.name) ? "block" : "warn";
        add("download-exec", severity, logicalStart, {
          line: logical,
          index: found.index,
        });
        break;
      }
    }
    logical = "";
  });
  // Markdown mentions both often enough apart; scripts and code count as a whole.
  const near = (a, b) =>
    !markdown(file.name) || Math.abs(a.number - b.number) <= CREDENTIAL_DISTANCE;
  const pairs = credentials.flatMap((credential) =>
    network.filter((call) => near(credential, call)).map((call) => [credential, call]),
  );
  const reported = new Set();
  for (const [credential, call] of pairs)
    for (const hit of [credential, call])
      if (!reported.has(hit.number)) {
        reported.add(hit.number);
        add("credential-exfiltration", "block", hit.number, hit);
      }
}

/**
 * Scans the files of one skill. `files` holds `[name, data, mode]` entries (as
 * unpackSkill returns them) or `{ name, data, mode }` objects; a mode with an execute
 * bit marks an executable. Returns `{ verdict, findings, rules, truncated }`:
 * `verdict` is "block" when any finding blocks, "warn" when any warns, else "ok";
 * `rules` names every rule that found something and `blocking` those that block;
 * each finding names its rule, severity, file, 1-based line (null for a whole file)
 * and a short excerpt with hidden characters made visible.
 */
export function scanSkill(files) {
  const findings = [];
  // Every rule hit counts for the verdict, also one past the finding limits.
  const hits = new Map();
  let truncated = false;
  const normalized = files.map(normalize);
  const followed = followedDocuments(normalized);
  for (const file of normalized.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const counts = new Map();
    const add = (rule, severity, line, at) => {
      if (hits.get(rule) !== "block") hits.set(rule, severity);
      const count = counts.get(rule) || 0;
      if (count >= SCAN_LIMITS.findingsPerRule || findings.length >= SCAN_LIMITS.findings)
        return void (truncated = true);
      counts.set(rule, count + 1);
      findings.push({
        rule,
        severity,
        file: visibleText(file.name),
        line,
        excerpt: at ? excerpt(at.line, at.index) : "",
      });
    };
    // A hidden character in a path can disguise what a file is (evil<U+202E>dm.sh).
    const nameHidden = hiddenCharacter(
      Array.from(file.name, (char) => char.codePointAt(0)),
    );
    if (nameHidden) add(nameHidden.rule, "warn", null, { line: file.name, index: 0 });
    if (file.mode & 0o111) {
      const firstLine = file.data.subarray(0, 512).toString("utf8").split("\n")[0];
      add(
        "executable-file",
        "warn",
        null,
        firstLine.startsWith("#!") ? { line: firstLine, index: 0 } : null,
      );
    }
    const text = readText(file.data);
    if (!text) {
      if (machineCode(file.data)) add("binary-executable", "warn", null, null);
      continue;
    }
    scanText(file, text, add, followed);
  }
  const rank = (finding) => SCAN_RULES.indexOf(finding.rule);
  findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      rank(a) - rank(b),
  );
  const rules = SCAN_RULES.filter((rule) => hits.has(rule));
  // The rules whose findings block; an override has to name each of them.
  const blocking = rules.filter((rule) => hits.get(rule) === "block");
  const verdict = blocking.length ? "block" : rules.length ? "warn" : "ok";
  return { verdict, findings, rules, blocking, truncated };
}

/**
 * SHA-256 over each file's path, execute bit and content hash in path order: the
 * identity a preview and its confirmation share.
 */
export function contentHash(files) {
  const hash = createHash("sha256");
  for (const file of files.map(normalize).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const content = createHash("sha256").update(file.data).digest("hex");
    hash.update(`${path.posix.normalize(file.name)}\0${file.mode & 0o111 ? "x" : "-"}\0`);
    hash.update(`${content}\0`);
  }
  return hash.digest("hex");
}
