import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mailError } from "./mail-connection.js";
import { mailFileType, mailFileTypes } from "./mail-file-types.js";
import { clipText } from "./mail-text.js";
import { documentKinds, htmlKinds } from "./mail-extract-kinds.js";

// Text of mail attachments for agents. Plain text is decoded here; PDF and Office
// documents are parsed in a separate Node.js process with a heap limit, a memory
// (RSS) limit, a time limit and an empty environment, at most `concurrency` at once
// with at most `queue` waiting. Mail HTML (mail-html.js) runs in the same kind of
// process from a pool of its own (`htmlPool`), so a read never waits behind
// attachment documents. A hostile document can only kill that process, which becomes
// MAIL_TEXT_FAILED; it can neither hang nor crash the server.

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

// The HTML pool: one process at a time, a short queue. A bounded mail parses in well
// under a second, so a read waits at most a few of them.
export const htmlPool = Object.freeze({ concurrency: 1, queue: 4 });

const kindsByType = new Map([
  [mailFileTypes[".pdf"], "pdf"],
  [mailFileTypes[".docx"], "docx"],
  [mailFileTypes[".xlsx"], "xlsx"],
  [mailFileTypes[".pptx"], "pptx"],
  [mailFileTypes[".txt"], "text"],
  [mailFileTypes[".csv"], "text"],
]);
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

// Busy, not broken: a search skips the attachment without caching a failure.
const busy = (extra) => Object.assign(failed(), { busy: true }, extra);

// A module-wide pool of processes: a finished extraction hands its place to the next
// caller. A caller whose `signal` aborts while it waits leaves the queue at once, so
// the bytes of a search that gave up are not held until a place frees.
class Pool {
  constructor(size) {
    this.size = size;
    this.running = 0;
    this.waiting = [];
    // Places taken so far (tests count the processes a call started).
    this.started = 0;
  }
  async acquire(signal) {
    if (signal?.aborted) throw busy({ cancelled: true });
    if (this.running < this.size.concurrency) {
      this.running++;
      this.started++;
      return;
    }
    if (this.waiting.length >= this.size.queue) throw busy();
    await new Promise((resolve, reject) => {
      const leave = () => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(busy({ cancelled: true }));
      };
      const entry = () => {
        signal?.removeEventListener("abort", leave);
        this.started++;
        resolve();
      };
      this.waiting.push(entry);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}

const pools = { document: new Pool(extractLimits), html: new Pool(htmlPool) };

/** Each pool's running and waiting processes and the places taken so far. */
export const extractionQueues = () =>
  Object.fromEntries(
    Object.entries(pools).map(([name, pool]) => [
      name,
      { running: pool.running, waiting: pool.waiting.length, started: pool.started },
    ]),
  );

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

// The signals that end a child for its document: V8's heap limit aborts it, the
// watchdog's memory (RSS) limit sends SIGUSR2 (mail-extract-child.js). Any other end
// (SIGKILL from a time limit or the OOM killer, SIGTERM or SIGINT at shutdown) can
// pass another time.
const documentSignals = new Set(["SIGABRT", "SIGUSR2"]);

// One process for one document. It is killed with SIGKILL at the time limit, and
// the promise settles only once it has exited (and was reaped). Only a reply followed
// by a clean exit counts; any signal or non-zero exit is MAIL_TEXT_FAILED, marked as
// the document's (`document: true`) only for the child's own `{ failed, document }`
// reply or a documentSignals end.
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
    // The child said the document could not be read.
    let unreadable = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, limits.timeoutMs);
    const settle = (result, byDocument = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(byDocument ? documentFailed() : failed());
    };
    child.on("message", (message) => {
      if (!reply && !unreadable && typeof message?.text === "string")
        reply = {
          text: message.text,
          truncated: message.truncated === true,
          ...(message.tooComplex === true && { tooComplex: true }),
          ...(typeof message.quote === "string" && { quote: message.quote }),
        };
      else if (!reply && !unreadable && message?.failed === true)
        unreadable = message.document === true;
      else kill();
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal && reply) settle(reply);
      else
        settle(
          null,
          (code === 1 && !signal && unreadable) || documentSignals.has(signal),
        );
    });
    child.once("error", () => {
      kill();
      if (child.pid === undefined) settle(null);
    });
    // A document that never reached the process is not its failure: killed, the
    // process ends with SIGKILL.
    child.send({ bytes, kind, limits: { ...limits } }, (error) => {
      if (error) kill();
    });
  });
}

/**
 * The text of one attachment as `{ text, truncated }`, at most `limits.textChars`
 * characters. Throws MAIL_TEXT_UNSUPPORTED for a kind without text and
 * MAIL_TEXT_FAILED for damaged, encrypted, oversized or too complex documents (both
 * with `document: true`), and MAIL_TEXT_FAILED without it when the time limit ran
 * out, the process did not start or was ended from outside (a signal, the OOM
 * killer) or could not load its extractor, or with `busy: true` when the queue is
 * full (and `cancelled: true` when `signal` aborted while it waited for a place).
 */
export async function extractText(
  bytes,
  kind,
  { charset, limits = extractLimits, scriptUrl = defaultScript, signal } = {},
) {
  if (kind === "text") {
    const end = byteCut(bytes, 4 * limits.textChars);
    const text = plainText(bytes.subarray(0, end), charset).replace(/\r\n?/g, "\n");
    const clipped = clipText(text, limits.textChars);
    return end < bytes.length ? { ...clipped, truncated: true } : clipped;
  }
  if (!documentKinds.has(kind)) throw documentFailed("MAIL_TEXT_UNSUPPORTED");
  if (!startsWith(bytes, kind === "pdf" ? pdfMagic : zipMagic)) throw documentFailed();
  const result = await inChild(bytes, kind, { limits, scriptUrl, signal });
  const clipped = clipText(result.text, limits.textChars);
  return { text: clipped.text, truncated: result.truncated || clipped.truncated };
}

/**
 * Runs `kind` on `input` in a child process (mail-extract-child.js) within one of
 * its pool's places (the HTML kinds in `htmlPool`, documents in the other): its
 * `{ text, truncated, tooComplex?, quote? }`, or MAIL_TEXT_FAILED as runChild and
 * the pool throw it. `signal` takes a caller that gave up out of the queue.
 */
export async function inChild(
  input,
  kind,
  { limits = extractLimits, scriptUrl = defaultScript, signal } = {},
) {
  // Only the known kinds start a process; an unknown one is a caller's bug.
  if (!htmlKinds.has(kind) && !documentKinds.has(kind))
    throw new TypeError("Unknown extraction kind.");
  const pool = htmlKinds.has(kind) ? pools.html : pools.document;
  await pool.acquire(signal);
  try {
    return await runChild(input, kind, limits, scriptUrl);
  } finally {
    pool.release();
  }
}
