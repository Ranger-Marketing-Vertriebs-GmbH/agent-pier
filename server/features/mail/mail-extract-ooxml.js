import yauzl from "yauzl";
import { clipText } from "./mail-text.js";

// Text of Office Open XML documents (docx, xlsx, pptx). The zip is checked before
// anything is inflated: no encrypted entries, at most `zipEntries` entries, no entry
// over `entryBytes` and no more than `zipBytes` in all. The XML is scanned, never
// parsed with a DTD: `<!DOCTYPE>` and `<!ENTITY>` are skipped and only the five
// predefined entities and character references are decoded. Runs only inside the
// extraction worker.

const failure = () => new Error("MAIL_TEXT_FAILED");

const sheetPart = /^xl\/worksheets\/sheet(\d+)\.xml$/;
const slidePart = /^ppt\/slides\/slide(\d+)\.xml$/;
const wanted = {
  docx: (name) => name === "word/document.xml",
  xlsx: (name) => name === "xl/sharedStrings.xml" || sheetPart.test(name),
  pptx: (name) => slidePart.test(name),
};

function readStream(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) stream.destroy(failure());
      else chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** The wanted entries of a zip, by name, after checking every entry's header. */
export function readZip(bytes, isWanted, limits) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const options = { lazyEntries: true, validateEntrySizes: true, strictFileNames: false };
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, options, (error, zip) => {
      if (error) return reject(error);
      if (zip.entryCount > limits.zipEntries) return reject(failure());
      const found = new Map();
      let total = 0;
      let stopped = false;
      const stop = (cause) => {
        stopped = true;
        zip.close();
        reject(cause);
      };
      zip.on("error", (cause) => !stopped && stop(cause));
      zip.on("end", () => !stopped && resolve(found));
      zip.on("entry", (entry) => {
        total += entry.uncompressedSize;
        if (
          entry.generalPurposeBitFlag & 1 ||
          entry.uncompressedSize > limits.entryBytes ||
          total > limits.zipBytes
        )
          return stop(failure());
        if (!isWanted(entry.fileName) || found.has(entry.fileName))
          return zip.readEntry();
        zip.openReadStream(entry, (openError, stream) => {
          if (openError) return stop(openError);
          readStream(stream, limits.entryBytes).then((data) => {
            found.set(entry.fileName, data);
            zip.readEntry();
          }, stop);
        });
      });
      zip.readEntry();
    });
  });
}

// --- XML scanning without a DTD.

const predefined = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const isXmlChar = (code) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/** Decodes the five predefined entities and character references; others stay. */
export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]{1,8}|#[0-9]{1,8}|[A-Za-z_][\w.-]*);/g,
    (whole, ref) => {
      if (ref[0] !== "#") return Object.hasOwn(predefined, ref) ? predefined[ref] : whole;
      const code =
        ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return isXmlChar(code) ? String.fromCodePoint(code) : whole;
    },
  );
}

// The index after `>` of a markup declaration such as <!DOCTYPE ... [ ... ]>, quotes
// and the internal subset included.
function declarationEnd(xml, at) {
  let depth = 0;
  let quote = "";
  for (let i = at + 2; i < xml.length; i++) {
    const c = xml[i];
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  return xml.length;
}

function tagEnd(xml, at) {
  let quote = "";
  for (let i = at + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

const skipTo = (xml, marker, from) => {
  const end = xml.indexOf(marker, from);
  return end === -1 ? xml.length : end + marker.length;
};

/**
 * Walks `xml` and calls `visit.open(local, tag, empty)`, `visit.close(local)` and
 * `visit.text(text)` with decoded text; a visitor returning `false` stops the walk.
 * `local` is the element name without its prefix.
 */
export function scanXml(xml, visit) {
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > at && visit.text(xml.slice(at, textEnd), false) === false) return;
    if (lt === -1) return;
    if (xml.startsWith("<!--", lt)) at = skipTo(xml, "-->", lt + 4);
    else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (visit.text(xml.slice(lt + 9, end === -1 ? xml.length : end), true) === false)
        return;
      at = end === -1 ? xml.length : end + 3;
    } else if (xml.startsWith("<?", lt)) at = skipTo(xml, "?>", lt + 2);
    else if (xml.startsWith("<!", lt)) at = declarationEnd(xml, lt);
    else {
      const gt = tagEnd(xml, lt);
      if (gt === -1) return;
      const tag = xml.slice(lt + 1, gt);
      const name = /^\/?\s*([^\s/>]+)/.exec(tag)?.[1] ?? "";
      const local = name.slice(name.indexOf(":") + 1);
      const result =
        tag[0] === "/" ? visit.close(local) : visit.open(local, tag, tag.endsWith("/"));
      if (result === false) return;
      at = gt + 1;
    }
  }
}

const typeAttribute = (tag) => /\st\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);

// Collects text up to the character limit; `add` answers false once it is reached.
class Sink {
  constructor(limit) {
    this.text = "";
    this.limit = limit;
  }
  get full() {
    return this.text.length > this.limit;
  }
  add(text) {
    this.text += text;
    return !this.full;
  }
}

// --- One reader per format.

function wordText(xml, sink) {
  let inText = false;
  let inRun = 0;
  scanXml(xml, {
    open(local, _tag, empty) {
      if (local === "r") inRun += empty ? 0 : 1;
      else if (local === "t") inText = !empty;
      else if (local === "p" && empty) return sink.add("\n");
      else if (inRun && local === "tab") return sink.add("\t");
      else if (inRun && (local === "br" || local === "cr")) return sink.add("\n");
    },
    close(local) {
      if (local === "r") inRun = Math.max(0, inRun - 1);
      else if (local === "t") inText = false;
      else if (local === "p") return sink.add("\n");
    },
    text(raw, cdata) {
      if (inText) return sink.add(cdata ? raw : decodeEntities(raw));
    },
  });
}

function sharedStrings(xml, limit) {
  const strings = [];
  let current = null;
  let inText = false;
  let phonetic = 0;
  scanXml(xml, {
    open(local, _tag, empty) {
      if (local === "si" && empty) strings.push("");
      else if (local === "si") current = "";
      else if (local === "rPh" && !empty) phonetic++;
      else if (local === "t") inText = !empty && !phonetic;
    },
    close(local) {
      if (local === "si" && current !== null) {
        strings.push(current);
        current = null;
      } else if (local === "rPh") phonetic = Math.max(0, phonetic - 1);
      else if (local === "t") inText = false;
    },
    text(raw, cdata) {
      if (inText && current !== null && current.length <= limit)
        current += cdata ? raw : decodeEntities(raw);
    },
  });
  return strings;
}

function sheetText(xml, strings, sink) {
  let cells = null;
  let cell = null;
  let collecting = false;
  const endCell = () => {
    if (!cell || !cells) return;
    cells.push(
      cell.type === "s" ? (strings[Number.parseInt(cell.value, 10)] ?? "") : cell.value,
    );
    cell = null;
  };
  scanXml(xml, {
    open(local, tag, empty) {
      if (local === "row") {
        if (empty) return sink.add("\n");
        cells = [];
      } else if (local === "c") {
        const match = typeAttribute(tag);
        cell = { type: match ? (match[1] ?? match[2]) : "", value: "" };
        if (empty) endCell();
      } else if (cell && (local === "v" || (local === "t" && cell.type === "inlineStr")))
        collecting = !empty;
    },
    close(local) {
      if (local === "v" || local === "t") collecting = false;
      else if (local === "c") endCell();
      else if (local === "row" && cells) {
        const line = `${cells.join("\t")}\n`;
        cells = null;
        return sink.add(line);
      }
    },
    text(raw, cdata) {
      if (collecting && cell) cell.value += cdata ? raw : decodeEntities(raw);
    },
  });
}

function slideText(xml, sink) {
  let inText = false;
  scanXml(xml, {
    open(local, _tag, empty) {
      if (local === "t") inText = !empty;
      else if (local === "br") return sink.add("\n");
    },
    close(local) {
      if (local === "t") inText = false;
      else if (local === "p") return sink.add("\n");
    },
    text(raw, cdata) {
      if (inText) return sink.add(cdata ? raw : decodeEntities(raw));
    },
  });
}

// The entries matching `pattern` in the order of their number.
const numbered = (entries, pattern) =>
  [...entries.keys()]
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(pattern.exec(a)[1]) - Number(pattern.exec(b)[1]));

/** The text of a docx, xlsx or pptx document. */
export async function ooxmlText(bytes, kind, limits) {
  if (!Object.hasOwn(wanted, kind)) throw failure();
  const entries = await readZip(bytes, wanted[kind], limits);
  const xml = (name) => entries.get(name).toString("utf8");
  const sink = new Sink(limits.textChars);
  if (kind === "docx") {
    if (!entries.has("word/document.xml")) throw failure();
    wordText(xml("word/document.xml"), sink);
  } else if (kind === "xlsx") {
    const strings = entries.has("xl/sharedStrings.xml")
      ? sharedStrings(xml("xl/sharedStrings.xml"), limits.textChars)
      : [];
    for (const [index, name] of numbered(entries, sheetPart).entries()) {
      if (index && !sink.add("\n")) break;
      sheetText(xml(name), strings, sink);
      if (sink.full) break;
    }
  } else {
    for (const [index, name] of numbered(entries, slidePart).entries()) {
      if (index && !sink.add("\n")) break;
      slideText(xml(name), sink);
      if (sink.full) break;
    }
  }
  return clipText(sink.text, limits.textChars);
}
