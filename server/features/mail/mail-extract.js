import { Worker } from "node:worker_threads";
import { mailError } from "./mail-connection.js";
import { mailFileType, mailFileTypes } from "./mail-file-types.js";
import { clipText } from "./mail-text.js";

// Text of mail attachments for agents. Plain text is decoded here; PDF and Office
// documents are parsed in a worker thread with its own heap, a time limit and at most
// `concurrency` workers at once, so a hostile document can neither hang nor crash the
// server.

export const extractLimits = Object.freeze({
  timeoutMs: 20_000,
  heapMb: 256,
  textChars: 1_000_000,
  concurrency: 2,
  pdfPages: 500,
  zipEntries: 2_000,
  zipBytes: 104_857_600,
  entryBytes: 52_428_800,
});

const kindsByType = new Map([
  [mailFileTypes[".pdf"], "pdf"],
  [mailFileTypes[".docx"], "docx"],
  [mailFileTypes[".xlsx"], "xlsx"],
  [mailFileTypes[".pptx"], "pptx"],
  [mailFileTypes[".txt"], "text"],
  [mailFileTypes[".csv"], "text"],
]);
const workerKinds = new Set(["pdf", "docx", "xlsx", "pptx"]);
const defaultWorker = new URL("./mail-extract-worker.js", import.meta.url);
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

// The module-wide worker queue: a finished worker hands its place to the next caller.
let running = 0;
const waiting = [];

async function acquire() {
  if (running < extractLimits.concurrency) {
    running++;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

const mebibyte = 1024 * 1024;
const memoryCheckMs = 100;

// One worker for one document; it is terminated once it answered, failed, ran out of
// time or held more than `heapMb` outside its heap (typed arrays, which the heap limit
// does not cover: a PDF stream inflates into them), and the promise settles only
// after it has exited.
function runWorker(bytes, kind, limits, workerUrl) {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(bytes);
    let worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: { bytes: copy, kind, limits: { ...limits } },
        transferList: [copy.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: limits.heapMb,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
    } catch {
      reject(failed());
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(memory);
      worker
        .terminate()
        .catch(() => {})
        .finally(() => (result ? resolve(result) : reject(failed())));
    };
    const timer = setTimeout(() => finish(null), limits.timeoutMs);
    const memory = setInterval(() => {
      worker.getHeapStatistics().then(
        (stats) => stats.external_memory > limits.heapMb * mebibyte && finish(null),
        () => {},
      );
    }, memoryCheckMs);
    worker.once("message", (message) =>
      finish(
        typeof message?.text === "string"
          ? { text: message.text, truncated: message.truncated === true }
          : null,
      ),
    );
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

/**
 * The text of one attachment as `{ text, truncated }`, at most `limits.textChars`
 * characters. Throws MAIL_TEXT_UNSUPPORTED for a kind without text and
 * MAIL_TEXT_FAILED for damaged, encrypted, oversized or too complex documents.
 */
export async function extractText(
  bytes,
  kind,
  { charset, limits = extractLimits, workerUrl = defaultWorker } = {},
) {
  if (kind === "text") {
    const text = plainText(bytes, charset).replace(/\r\n?/g, "\n");
    return clipText(text, limits.textChars);
  }
  if (!workerKinds.has(kind)) throw mailError("MAIL_TEXT_UNSUPPORTED");
  if (!startsWith(bytes, kind === "pdf" ? pdfMagic : zipMagic)) throw failed();
  await acquire();
  try {
    const result = await runWorker(bytes, kind, limits, workerUrl);
    const clipped = clipText(result.text, limits.textChars);
    return { text: clipped.text, truncated: result.truncated || clipped.truncated };
  } finally {
    release();
  }
}
