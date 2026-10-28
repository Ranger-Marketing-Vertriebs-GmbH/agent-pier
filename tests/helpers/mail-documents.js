import zlib from "node:zlib";
import yazl from "yazl";

// Small documents for mail attachment tests: a PDF with one text object and the
// Office Open XML formats with the least each needs to be read, plus raw MIME
// messages with text, HTML and attachments.

const escapePdf = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A PDF with one page per text (a string is one page), each in one `Tj` object.
 * `encrypt` adds a standard security handler whose user password is not empty.
 */
export function pdfWith(texts, { encrypt = false } = {}) {
  const pages = [texts].flat();
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 712 Td (${escapePdf(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (encrypt)
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`,
    );
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const security = encrypt
    ? ` /Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`
    : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${security} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * A one-page PDF whose content stream is `megabytes` MiB of spaces, compressed with
 * FlateDecode to about a thousandth of that: a decompression bomb.
 */
export async function pdfBomb(megabytes) {
  const deflate = zlib.createDeflate({ level: 9 });
  const chunks = [];
  deflate.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  const spaces = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < megabytes; i++) deflate.write(spaces);
  deflate.end();
  await done;
  const stream = Buffer.concat(chunks);
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let size = parts[0].length;
  const add = (part) => {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part, "latin1");
    parts.push(bytes);
    size += bytes.length;
  };
  for (const body of [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
  ]) {
    offsets.push(size);
    add(`${offsets.length} 0 obj\n${body}\nendobj\n`);
  }
  offsets.push(size);
  add(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
  add(stream);
  add("\nendstream\nendobj\n");
  const xref = size;
  add(`xref\n0 5\n0000000000 65535 f \n`);
  for (const offset of offsets) add(`${String(offset).padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const xmlText = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot" }[c]};`,
  );

const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const relsNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const docRel =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

function contentTypes(overrides) {
  const parts = overrides
    .map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`)
    .join("");
  return `${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts}</Types>`;
}

const rels = (entries) =>
  `${xmlHead}<Relationships xmlns="${relsNs}">${entries
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;

/** The zip of `files` ({ name: text }), as a Buffer. */
export function zipOf(files) {
  const zip = new yazl.ZipFile();
  for (const [name, text] of Object.entries(files))
    zip.addBuffer(Buffer.from(text, "utf8"), name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const officeNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A .docx whose one paragraph is `text`. */
export function docxWith(text) {
  const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return zipOf({
    "[Content_Types].xml": contentTypes([
      [
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ],
    ]),
    "_rels/.rels": rels([["rId1", docRel, "word/document.xml"]]),
    "word/document.xml": `${xmlHead}<w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>${xmlText(text)}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

const column = (index) => String.fromCharCode(65 + index);

/** A .xlsx with one sheet of `rows`, each cell a shared string. */
export function xlsxWith(rows) {
  const s = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const strings = [];
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          strings.push(value);
          return `<c r="${column(c)}${r + 1}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const shared = strings.map((value) => `<si><t>${xmlText(value)}</t></si>`).join("");
  return zipOf({
    "[Content_Types].xml": contentTypes([
      [
        "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      ],
      [
        "xl/worksheets/sheet1.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      ],
      [
        "xl/sharedStrings.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
      ],
    ]),
    "_rels/.rels": rels([["rId1", docRel, "xl/workbook.xml"]]),
    "xl/workbook.xml": `${xmlHead}<workbook xmlns="${s}" xmlns:r="${officeNs}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels([
      ["rId1", `${officeNs}/worksheet`, "worksheets/sheet1.xml"],
      ["rId2", `${officeNs}/sharedStrings`, "sharedStrings.xml"],
    ]),
    "xl/worksheets/sheet1.xml": `${xmlHead}<worksheet xmlns="${s}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `${xmlHead}<sst xmlns="${s}" count="${strings.length}" uniqueCount="${strings.length}">${shared}</sst>`,
  });
}

/** A .pptx with one slide whose one text box holds `text`. */
export function pptxWith(text) {
  const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
  return zipOf({
    "[Content_Types].xml": contentTypes([
      [
        "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      ],
      [
        "ppt/slides/slide1.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
      ],
    ]),
    "_rels/.rels": rels([["rId1", docRel, "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `${xmlHead}<p:presentation xmlns:p="${p}" xmlns:r="${officeNs}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([
      ["rId1", `${officeNs}/slide`, "slides/slide1.xml"],
    ]),
    "ppt/slides/slide1.xml": `${xmlHead}<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xmlText(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  });
}

/** A PDF that needs a password to open. */
export const encryptedPdf = () => pdfWith("geheim", { encrypt: true });

// --- Hostile zips: the central directory is rewritten after yazl wrote it.

// Calls `edit(buffer, headerOffset)` for each central directory header of `zip`,
// and `local(buffer, localOffset)` for the local header it points to.
function patchEntries(zip, edit, local = () => {}) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const name = zip.toString("utf8", at + 46, at + 46 + zip.readUInt16LE(at + 28));
    edit(zip, at, name);
    local(zip, zip.readUInt32LE(at + 42), name);
    at +=
      46 +
      zip.readUInt16LE(at + 28) +
      zip.readUInt16LE(at + 30) +
      zip.readUInt16LE(at + 32);
  }
  return zip;
}

/**
 * A .docx whose `word/document.xml` declares an uncompressed size of 64 MiB, over
 * the 50 MiB entry limit, without the bytes to back it.
 */
export async function zipBombDocx() {
  return patchEntries(await docxWith("bomb"), (zip, at, name) => {
    if (name === "word/document.xml") zip.writeUInt32LE(64 * 1024 * 1024, at + 24);
  });
}

/**
 * A .docx whose `word/document.xml` inflates to 1 MiB while its headers declare 100
 * bytes: a bomb that lies about its size.
 */
export async function understatedDocx() {
  const zip = await zipOf({
    "word/document.xml": `<w:t>${"a".repeat(1024 * 1024)}</w:t>`,
  });
  const declare = (offset) => (bytes, at) => bytes.writeUInt32LE(100, at + offset);
  return patchEntries(zip, declare(24), declare(22));
}

/** A .docx whose entries all carry the "encrypted" flag (general purpose bit 0). */
export async function encryptedZipDocx() {
  const flag = (offset) => (zip, at) =>
    zip.writeUInt16LE(zip.readUInt16LE(at + offset) | 1, at + offset);
  return patchEntries(await docxWith("secret"), flag(8), flag(6));
}

// --- Raw MIME messages.

const utf8Latin1 = (text) => Buffer.from(text, "utf8").toString("latin1");

function encodeBody(content, encoding) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  if (encoding === "base64")
    return (bytes.toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
  if (encoding === "quoted-printable") {
    let out = "";
    let line = 0;
    for (const byte of bytes) {
      const char =
        byte >= 33 && byte <= 126 && byte !== 61
          ? String.fromCharCode(byte)
          : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      if (line + char.length > 75) {
        out += "=\r\n";
        line = 0;
      }
      out += char;
      line += char.length;
    }
    return out;
  }
  return bytes.toString("latin1");
}

const textPart = (type, text) =>
  `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${utf8Latin1(text)}`;

/**
 * A raw message (CRLF, one latin1 character per byte) with `text`, an HTML
 * alternative when `html` is given, and `attachments` ({ name, type, content,
 * encoding = "base64" }) in a multipart/mixed.
 */
export function mimeWith({ subject = "Test", text = "", html, attachments = [] }) {
  const head = `From: owner@example.com\r\nTo: bob@example.org\r\nSubject: ${subject}\r\nDate: Tue, 27 Oct 2026 13:00:00 +0000\r\nMessage-ID: <mime-${Math.random().toString(36).slice(2)}@example.com>\r\nMIME-Version: 1.0\r\n`;
  let body = textPart("text/plain", text);
  if (html !== undefined)
    body = `Content-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\n${body}\r\n--alt\r\n${textPart("text/html", html)}\r\n--alt--\r\n`;
  if (!attachments.length) return `${head}${body}`;
  const parts = attachments.map(
    ({ name, type, content, encoding = "base64" }) =>
      `Content-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${encodeBody(content, encoding)}`,
  );
  return `${head}Content-Type: multipart/mixed; boundary="mix"\r\n\r\n${[body, ...parts]
    .map((part) => `--mix\r\n${part}\r\n`)
    .join("")}--mix--\r\n`;
}
