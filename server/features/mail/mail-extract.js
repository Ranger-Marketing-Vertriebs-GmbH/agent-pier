import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mailError } from "./mail-connection.js";
import { mailFileType, mailFileTypes } from "./mail-file-types.js";
import { clipText } from "./mail-text.js";

// Text of mail attachments for agents. Plain text is decoded here; PDF and Office
// documents are parsed in a separate Node.js process with a heap limit, a memory
// (RSS) limit, a time limit and an empty environment, at most `concurrency` at once
// with at most `queue` waiting. A hostile document can only kill that process, which
// becomes MAIL_TEXT_FAILED; it can neither hang nor crash the server.

export const extractLimits = Object.freeze({
  timeoutMs: 20_000,
  heapMb: 256,
  textChars: 1_000_000,
  concurrency: 2,
  pdfPages: 500,
  zipEntries: 2_000,
  zipBytes: 104_857_600,
  entryBytes: 52_428_800,
  rssMb: 512,
  queue: 16,
});

const kindsByType = new Map([
  [mailFileTypes[".pdf"], "pdf"],
  [mailFileTypes[".docx"], "docx"],
  [mailFileTypes[".xlsx"], "xlsx"],
  [mailFileTypes[".pptx"], "pptx"],
  [mailFileTypes[".txt"], "text"],
  [mailFileTypes[".csv"], "text"],
]);
const childKinds = new Set(["pdf", "docx", "xlsx", "pptx"]);
const defaultScript = new URL("./mail-extract-child.js", import.meta.url);
const pdfMagic = Buffer.from("%PDF-", "latin1");
const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * The kind of text extraction for an attachment: by its MIME type, and by its
 * extension when the type is `application/octet-stream`. `null` when no text can be
 * read from it.
 */
export function extractableKind({ type, name } = {}) {
  let mime = String(type ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mime === "application/octet-stream") mime = mailFileType(name ?? "");
  return kindsByType.get(mime) ?? null;
}

const failed = () => mailError("MAIL_TEXT_FAILED");
// A failure the document itself caused (damaged, encrypted, a bomb, no text kind):
// the same next time, so a cache may keep it. Time limits, a failed start and a
// full queue are not marked: they can pass under less load.
const documentFailed = (code = "MAIL_TEXT_FAILED") =>
  Object.assign(mailError(code), { document: true });

// A UTF-8 decode that refuses invalid bytes, so they can fall back to latin1.
function strictUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decoderFor(label) {
  try {
    return label ? new TextDecoder(String(label).trim()) : null;
  } catch {
    return null;
  }
}

// The end of the first `max` bytes, moved back to the start of a UTF-8 character and
// to an even length, so a cut neither turns valid UTF-8 invalid nor splits UTF-16.
function byteCut(bytes, max) {
  if (bytes.length <= max) return bytes.length;
  let end = max - (max % 2);
  for (let back = 0; back < 3 && end > 0 && (bytes[end] & 0xc0) === 0x80; back++) end--;
  return end;
}

/** Plain text: a BOM wins, then the charset label; invalid UTF-8 is read as latin1. */
function plainText(bytes, charset) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const decoder = decoderFor(charset);
  if (decoder && decoder.encoding !== "utf-8") return decoder.decode(bytes);
  return strictUtf8(bytes) ?? Buffer.from(bytes).toString("latin1");
}

const startsWith = (bytes, magic) =>
  bytes.length >= magic.length && magic.equals(bytes.subarray(0, magic.length));

// The module-wide queue: a finished extraction hands its place to the next caller.
let running = 0;
const waiting = [];

async function acquire() {
  if (running < extractLimits.concurrency) {
    running++;
    return;
  }
  // Busy, not broken: a search skips the attachment without caching a failure.
  if (waiting.length >= extractLimits.queue)
    throw Object.assign(failed(), { busy: true });
  await new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

// Children still running are killed when the server process exits.
const children = new Set();
let exitHook = false;
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    for (const running of children) running.kill("SIGKILL");
  });
}

// One process for one document. It is killed with SIGKILL at the time limit, and
// the promise settles only once it has exited (and was reaped). Only a reply followed
// by a clean exit counts; any signal or non-zero exit is MAIL_TEXT_FAILED.
function runChild(bytes, kind, limits, scriptUrl) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(fileURLToPath(scriptUrl), [], {
        execArgv: [
          `--max-old-space-size=${limits.heapMb}`,
          "--max-semi-space-size=16",
          "--disallow-code-generation-from-strings",
          "--no-addons",
        ],
        env: {},
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      });
    } catch {
      reject(failed());
      return;
    }
    track(child);
    let reply = null;
    let settled = false;
    // Set when the process ends for a reason other than the document.
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limits.timeoutMs);
    // Any end but the time limit or a failed start is the document's doing: a parse
    // error, the heap or memory limit, or an answer that is no text.
    const settle = (result, started = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(timedOut || !started ? failed() : documentFailed());
    };
    child.on("message", (message) => {
      if (!reply && typeof message?.text === "string")
        reply = { text: message.text, truncated: message.truncated === true };
      else kill();
    });
    child.once("exit", (code, signal) => settle(code === 0 && !signal ? reply : null));
    child.once("error", () => {
      kill();
      if (child.pid === undefined) settle(null, false);
    });
    child.send({ bytes, kind, limits: { ...limits } }, (error) => {
      if (!error) return;
      // The document never reached the process: not its failure.
      timedOut = true;
      kill();
    });
  });
}

/**
 * The text of one attachment as `{ text, truncated }`, at most `limits.textChars`
 * characters. Throws MAIL_TEXT_UNSUPPORTED for a kind without text and
 * MAIL_TEXT_FAILED for damaged, encrypted, oversized or too complex documents (both
 * with `document: true`), and MAIL_TEXT_FAILED without it when the time limit ran
 * out or the process did not start, or with `busy: true` when the queue is full.
 */
export async function extractText(
  bytes,
  kind,
  { charset, limits = extractLimits, scriptUrl = defaultScript } = {},
) {
  if (kind === "text") {
    const end = byteCut(bytes, 4 * limits.textChars);
    const text = plainText(bytes.subarray(0, end), charset).replace(/\r\n?/g, "\n");
    const clipped = clipText(text, limits.textChars);
    return end < bytes.length ? { ...clipped, truncated: true } : clipped;
  }
  if (!childKinds.has(kind)) throw documentFailed("MAIL_TEXT_UNSUPPORTED");
  if (!startsWith(bytes, kind === "pdf" ? pdfMagic : zipMagic)) throw documentFailed();
  await acquire();
  try {
    const result = await runChild(bytes, kind, limits, scriptUrl);
    const clipped = clipText(result.text, limits.textChars);
    return { text: clipped.text, truncated: result.truncated || clipped.truncated };
  } finally {
    release();
  }
}
