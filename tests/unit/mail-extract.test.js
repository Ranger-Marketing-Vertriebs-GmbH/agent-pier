import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  extractableKind,
  extractLimits,
  extractText,
} from "../../server/features/mail/mail-extract.js";
import {
  docxWith,
  encryptedPdf,
  encryptedZipDocx,
  pdfBomb,
  pdfWith,
  pptxWith,
  understatedDocx,
  xlsxWith,
  zipBombDocx,
  zipOf,
} from "../helpers/mail-documents.js";

const hangUrl = new URL("../fixtures/mail-extract-hang.mjs", import.meta.url);
const greedyUrl = new URL("../fixtures/mail-extract-greedy.mjs", import.meta.url);
const endsUrl = new URL("../fixtures/mail-extract-ends.mjs", import.meta.url);
const failed = { code: "MAIL_TEXT_FAILED" };
// The document's own failure, which a cache may keep.
const broken = { code: "MAIL_TEXT_FAILED", document: true };
const wordNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docxXml = (body, head = "") =>
  zipOf({
    "word/document.xml": `<?xml version="1.0"?>${head}<w:document ${wordNs}><w:body>${body}</w:body></w:document>`,
  });

test("text comes out of every supported kind", async () => {
  assert.match((await extractText(pdfWith("Rechnung 49,99 EUR"), "pdf")).text, /49,99/);
  assert.match(
    (await extractText(await docxWith("Telekom September"), "docx")).text,
    /Telekom September/,
  );
  assert.match(
    (await extractText(await xlsxWith([["Betrag", "49.99"]]), "xlsx")).text,
    /Betrag\t49\.99/,
  );
  assert.match((await extractText(await pptxWith("Q3 plan"), "pptx")).text, /Q3 plan/);
  assert.deepEqual(
    await extractText(Buffer.from("Grüße", "latin1"), "text", { charset: "iso-8859-1" }),
    { text: "Grüße", truncated: false },
  );
});

test("kinds follow type and name", () => {
  assert.equal(
    extractableKind({ type: "application/octet-stream", name: "a.DOCX" }),
    "docx",
  );
  assert.equal(extractableKind({ type: "image/png", name: "a.png" }), null);
  assert.equal(extractableKind({ type: "Application/PDF", name: "x" }), "pdf");
  assert.equal(extractableKind({ type: "text/csv; charset=utf-8", name: "a" }), "text");
  assert.equal(extractableKind({ type: "text/plain", name: "a.pdf" }), "text");
  assert.equal(
    extractableKind({ type: "application/octet-stream", name: "notes.txt" }),
    "text",
  );
  assert.equal(
    extractableKind({ type: "application/octet-stream", name: "a.csv" }),
    "text",
  );
  assert.equal(
    extractableKind({ type: "application/octet-stream", name: "a.bin" }),
    null,
  );
  assert.equal(extractableKind({ type: "image/png", name: "a.pdf" }), null);
  assert.equal(
    extractableKind({
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      name: "",
    }),
    "pptx",
  );
});

test("an unsupported kind is refused before any work", async () => {
  for (const kind of [null, undefined, "png", "toString"])
    await assert.rejects(extractText(Buffer.from("x"), kind), {
      code: "MAIL_TEXT_UNSUPPORTED",
      document: true,
    });
});

// A page tree whose only kid is the tree itself (same length, so offsets hold).
const cyclicPdf = () =>
  Buffer.from(
    pdfWith("x").toString("latin1").replace("/Kids [4 0 R]", "/Kids [2 0 R]"),
    "latin1",
  );

test("malformed, encrypted and bomb documents fail cleanly", async () => {
  for (const [bytes, kind] of [
    [pdfWith("x").subarray(0, 40), "pdf"],
    [Buffer.from("PK\x03\x04junk"), "docx"],
    [await zipBombDocx(), "docx"],
    [await encryptedZipDocx(), "docx"],
    [await understatedDocx(), "docx"],
    [encryptedPdf(), "pdf"],
    [cyclicPdf(), "pdf"],
    [Buffer.from("not a pdf"), "pdf"],
    [pdfWith("x"), "docx"],
    [await docxWith("x"), "pdf"],
    [Buffer.alloc(0), "xlsx"],
  ])
    await assert.rejects(extractText(bytes, kind), broken);
});

test("zips over the entry count or the uncompressed total are refused", async () => {
  const many = {};
  for (let i = 0; i <= 20; i++) many[`ppt/slides/slide${i}.xml`] = "<a:t>x</a:t>";
  const limits = { ...extractLimits, zipEntries: 20 };
  await assert.rejects(extractText(await zipOf(many), "pptx", { limits }), failed);
  delete many["ppt/slides/slide0.xml"];
  assert.match((await extractText(await zipOf(many), "pptx", { limits })).text, /x/);

  const big = await docxXml(`<w:p><w:r><w:t>${"a".repeat(5_000)}</w:t></w:r></w:p>`);
  for (const tight of [{ zipBytes: 4_000 }, { entryBytes: 4_000 }])
    await assert.rejects(
      extractText(big, "docx", { limits: { ...extractLimits, ...tight } }),
      failed,
    );
});

test("a hanging extractor is stopped at the time limit", async () => {
  const started = Date.now();
  await assert.rejects(
    extractText(pdfWith("x"), "pdf", {
      scriptUrl: hangUrl,
      limits: { ...extractLimits, timeoutMs: 200 },
    }),
    (error) => {
      // A time limit can pass under less load: not the document's failure.
      assert.equal(error.code, "MAIL_TEXT_FAILED");
      assert.equal(error.document, undefined);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000);
});

test("an extractor over its heap limit dies alone", async () => {
  await assert.rejects(
    extractText(pdfWith("x"), "pdf", {
      scriptUrl: greedyUrl,
      limits: { ...extractLimits, heapMb: 32 },
    }),
    broken,
  );
  assert.match((await extractText(pdfWith("still here"), "pdf")).text, /still here/);
});

test("only the child's own report or a memory limit marks the document as failed", async () => {
  const end = (how) =>
    extractText(Buffer.from(`%PDF-${how}`), "pdf", { scriptUrl: endsUrl });
  // Ended from outside (shutdown, the OOM killer, a watchdog deadline under load), or
  // the extractor could not be loaded: the same document may work next time.
  for (const how of [
    "signal:SIGTERM",
    "signal:SIGINT",
    "signal:SIGKILL",
    "exit:1",
    'reply:{"failed":true}',
  ])
    await assert.rejects(end(how), (error) => {
      assert.equal(error.code, "MAIL_TEXT_FAILED", how);
      assert.equal(error.document, undefined, how);
      return true;
    });
  // The document could not be read, or ran into the heap (SIGABRT) or RSS (SIGUSR2)
  // limit.
  for (const how of [
    'reply:{"failed":true,"document":true}',
    "signal:SIGABRT",
    "signal:SIGUSR2",
  ])
    await assert.rejects(end(how), broken, how);
});

test("a PDF that inflates past the memory (RSS) limit is stopped", async () => {
  const bomb = await pdfBomb(400);
  assert.ok(bomb.length < 1024 * 1024);
  const started = Date.now();
  await assert.rejects(extractText(bomb, "pdf"), broken);
  assert.ok(Date.now() - started < 5_000);
  const roomy = { ...extractLimits, rssMb: 4_096 };
  assert.deepEqual(await extractText(bomb, "pdf", { limits: roomy }), {
    text: "",
    truncated: false,
  });
  // The same document, small enough, has no text but is not an error.
  assert.deepEqual(await extractText(await pdfBomb(2), "pdf"), {
    text: "",
    truncated: false,
  });
});

test("exactly two extractors run at once and the queue is bounded", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-extract-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, "starts.log");
  const limits = { ...extractLimits, timeoutMs: 400 };
  const runs = Array.from({ length: 4 }, () =>
    extractText(Buffer.from(`%PDF-log:${log}`), "pdf", { scriptUrl: hangUrl, limits }),
  );
  const results = await Promise.allSettled(runs);
  assert.deepEqual(
    results.map((result) => result.reason?.code),
    Array(4).fill("MAIL_TEXT_FAILED"),
  );
  const starts = (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => Number(line.split(" ")[0]));
  starts.sort((a, b) => a - b);
  assert.equal(starts.length, 4);
  assert.ok(starts[1] - starts[0] < 300, "the first two start together");
  assert.ok(starts[2] - starts[0] >= 350, "the third waits for a free place");
  assert.ok(starts[3] - starts[1] >= 350, "the fourth waits for a free place");

  // Two running and 16 waiting fill the queue; the next caller is refused at once.
  const queued = Array.from({ length: 18 }, () =>
    extractText(pdfWith("x"), "pdf", {
      scriptUrl: hangUrl,
      limits: { ...extractLimits, timeoutMs: 100 },
    }).catch((error) => error),
  );
  const refusedAt = Date.now();
  await assert.rejects(extractText(pdfWith("x"), "pdf"), {
    code: "MAIL_TEXT_FAILED",
    busy: true,
  });
  assert.ok(Date.now() - refusedAt < 100);
  for (const error of await Promise.all(queued)) {
    assert.equal(error.code, "MAIL_TEXT_FAILED");
    // A document that ran and failed is no busy queue.
    assert.equal(error.busy, undefined);
  }
});

test("the caller's bytes stay intact after the extractor took its copy", async () => {
  const bytes = pdfWith("kept");
  const before = Buffer.from(bytes);
  await extractText(bytes, "pdf");
  assert.deepEqual(bytes, before);
});

test("text stops at the character cap", async () => {
  const limits = { ...extractLimits, textChars: 1_000 };
  const docx = await extractText(await docxWith("a".repeat(2_000)), "docx", { limits });
  assert.equal(docx.truncated, true);
  assert.equal(docx.text, "a".repeat(1_000));
  const text = await extractText(Buffer.from("b".repeat(2_000)), "text", { limits });
  assert.deepEqual(text, { text: "b".repeat(1_000), truncated: true });
  // PDF.js drops text beyond the page edge, so the PDF spreads it over 30 pages.
  const pdf = await extractText(pdfWith(Array(30).fill("c".repeat(60))), "pdf", {
    limits,
  });
  assert.equal(pdf.truncated, true);
  assert.equal(pdf.text.length, 1_000);
  const whole = await extractText(await docxWith("short"), "docx", { limits });
  assert.equal(whole.truncated, false);
});

test("PDF pages are read in order up to the page limit", async () => {
  const pdf = pdfWith(["Seite eins", "Seite zwei", "Seite drei"]);
  const all = await extractText(pdf, "pdf");
  assert.equal(all.text, "Seite eins\n\nSeite zwei\n\nSeite drei");
  assert.equal(all.truncated, false);
  const two = await extractText(pdf, "pdf", {
    limits: { ...extractLimits, pdfPages: 2 },
  });
  assert.deepEqual(two, { text: "Seite eins\n\nSeite zwei", truncated: true });
});

test("XML entities are decoded but never expanded from a DOCTYPE", async () => {
  const head = '<!DOCTYPE w:document [<!ENTITY boom "BOOM"><!ENTITY x "&boom;&boom;">]>';
  const body =
    "<w:p><w:r><w:t>&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65;&#x42;&#x1F600; &x; &boom; &#0; &#xD800;</w:t></w:r></w:p>";
  const { text } = await extractText(await docxXml(body, head), "docx");
  assert.doesNotMatch(text, /BOOM/);
  assert.equal(text, "<a> & \"b\" 'c' AB😀 &x; &boom; &#0; &#xD800;\n");
});

test("docx keeps paragraphs, tabs, comments and CDATA apart from markup", async () => {
  const body =
    '<w:p><w:r><w:t xml:space="preserve">Konto</w:t><w:tab/><w:t>4711</w:t></w:r></w:p>' +
    "<!-- <w:t>hidden</w:t> --><w:p><w:r><w:t><![CDATA[a <b> &amp;]]></w:t></w:r></w:p>" +
    "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>";
  const { text } = await extractText(await docxXml(body), "docx");
  assert.equal(text, "Konto\t4711\na <b> &amp;\n\n");
});

test("xlsx resolves shared and inline strings and reads sheets in number order", async () => {
  const s = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const sheet = (rows) => `<worksheet ${s}><sheetData>${rows}</sheetData></worksheet>`;
  const zip = await zipOf({
    "xl/sharedStrings.xml": `<sst ${s}><si><t>Name</t></si><si><r><t>Mül</t></r><r><t>ler</t></r><rPh><t>ignored</t></rPh></si></sst>`,
    "xl/worksheets/sheet10.xml": sheet('<row><c t="s"><v>0</v></c></row>'),
    "xl/worksheets/sheet2.xml": sheet(
      '<row><c t="s"><v>1</v></c><c><v>3.5</v></c><c t="inlineStr"><is><t>frei</t></is></c></row><row><c t="b"><v>1</v></c><c t="s"><v>99</v></c></row>',
    ),
    "xl/worksheets/sheet1.xml": sheet('<row><c t="s"><v>0</v></c></row>'),
  });
  const { text } = await extractText(zip, "xlsx");
  assert.equal(text, "Name\n\nMüller\t3.5\tfrei\n1\t\n\nName\n");
});

test("pptx reads slides in number order", async () => {
  const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const slide = (text) => `<p:sld ${a}><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  const zip = await zipOf({
    "ppt/slides/slide11.xml": slide("elf"),
    "ppt/slides/slide2.xml": slide("zwei"),
    "ppt/slides/slide1.xml": slide("eins"),
    "ppt/notesSlides/notesSlide1.xml": slide("notiz"),
  });
  assert.equal((await extractText(zip, "pptx")).text, "eins\n\nzwei\n\nelf\n");
});

test("plain text honours BOMs, charsets and falls back to latin1", async () => {
  const cases = [
    [Buffer.from("﻿Äpfel", "utf8"), undefined, "Äpfel"],
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Öl", "utf16le")]), "", "Öl"],
    [Buffer.from([0xfe, 0xff, 0x00, 0xdc]), "utf-8", "Ü"],
    [Buffer.from("Größe", "utf8"), undefined, "Größe"],
    [Buffer.from("Größe", "latin1"), "utf-8", "Größe"],
    [Buffer.from("Größe", "latin1"), undefined, "Größe"],
    [Buffer.from("Größe", "latin1"), "no-such-charset", "Größe"],
    [Buffer.from([0x80]), "windows-1252", "€"],
    [Buffer.from("a\r\nb\rc", "utf8"), undefined, "a\nb\nc"],
  ];
  for (const [bytes, charset, expected] of cases)
    assert.equal((await extractText(bytes, "text", { charset })).text, expected);
});

test("a tiny xlsx that repeats a huge shared string is cut, not fatal", async () => {
  const s = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const zip = await zipOf({
    "xl/sharedStrings.xml": `<sst ${s}><si><t>${"a".repeat(900_000)}</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${s}><sheetData><row>${'<c t="s"><v>0</v></c>'.repeat(5_000)}</row></sheetData></worksheet>`,
  });
  assert.ok(zip.length < 4_096);
  const { text, truncated } = await extractText(zip, "xlsx");
  assert.equal(truncated, true);
  assert.equal(text.length, extractLimits.textChars);
  assert.match(text, /^a{32767}\ta{32767}\t/);
  assert.match((await extractText(pdfWith("alive"), "pdf")).text, /alive/);
});

test("xlsx shared strings past their budget become empty and mark the text cut", async () => {
  const s = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const si = (text) => `<si><t>${text}</t></si>`;
  const zip = await zipOf({
    "xl/sharedStrings.xml": `<sst ${s}>${si("x".repeat(30))}${si("y".repeat(30))}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${s}><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>`,
  });
  const limits = { ...extractLimits, textChars: 20 };
  assert.deepEqual(
    await extractText(zip, "xlsx", { limits: { ...limits, textChars: 100 } }),
    {
      text: `${"x".repeat(30)}\t${"y".repeat(30)}\n`,
      truncated: false,
    },
  );
  const cut = await extractText(zip, "xlsx", { limits: { ...limits, textChars: 25 } });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "x".repeat(25));
});

test("plain text is cut by bytes before decoding, on a character boundary", async () => {
  const limits = { ...extractLimits, textChars: 4 };
  const utf8 = await extractText(Buffer.from("ääääääää", "utf8"), "text", { limits });
  assert.deepEqual(utf8, { text: "ääää", truncated: true });
  const odd = await extractText(Buffer.from("aaaaaaaaaaaaaaaaaaaaa€", "utf8"), "text", {
    limits,
  });
  assert.deepEqual(odd, { text: "aaaa", truncated: true });
});

test("the extractor gets no environment and no stdio from the server", async () => {
  process.env.MAIL_EXTRACT_TEST_SECRET = "s3cret";
  try {
    const probe = new URL("../fixtures/mail-extract-env.mjs", import.meta.url);
    const { text } = await extractText(pdfWith("x"), "pdf", { scriptUrl: probe });
    const seen = JSON.parse(text);
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process.
    assert.deepEqual(
      seen.env.filter((name) => name !== "__CF_USER_TEXT_ENCODING"),
      [],
    );
    assert.equal(seen.discarded, true);
  } finally {
    delete process.env.MAIL_EXTRACT_TEST_SECRET;
  }
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a running extractor dies with the server process", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-extract-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, "starts.log");
  const extract = new URL("../../server/features/mail/mail-extract.js", import.meta.url);
  const server = `
    import fs from "node:fs";
    const { extractText } = await import(${JSON.stringify(extract.href)});
    extractText(Buffer.from("%PDF-log:" + ${JSON.stringify(log)}), "pdf", {
      scriptUrl: new URL(${JSON.stringify(hangUrl.href)}),
    }).catch(() => {});
    const started = Date.now();
    while (!fs.existsSync(${JSON.stringify(log)}) && Date.now() - started < 5000)
      await new Promise((resolve) => setTimeout(resolve, 20));
    process.exit(0);`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", server]);
  const pid = Number((await fs.readFile(log, "utf8")).trim().split(" ")[1]);
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(pid), false);
});
