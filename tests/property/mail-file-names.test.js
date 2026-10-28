import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { hasHiddenCharacters } from "../../server/features/assistants/agent-ssh-text.js";
import {
  numberedName,
  safeFileName,
} from "../../server/features/assistants/mail/agent-mail-file-names.js";

const nameBytes = 180;
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const forbidden = /[/\\<>:"|?*\u0000-\u001f]/;

// Characters a sender may hide or smuggle into a name: controls, bidi overrides,
// zero-width and other format characters, line separators, Hangul fillers, path
// separators, dots, combining marks (NFD) and multi-byte letters.
const tricky = fc.constantFrom(
  "\u0000",
  "\u0007",
  "\t",
  "\n",
  "\u007f",
  "\u0085",
  "\u00ad",
  "\u200b",
  "\u200d",
  "\u202e",
  "\u2066",
  "\u2028",
  "\u2029",
  "\u115f",
  "\u3164",
  "\ufe0f",
  "\ufeff",
  "\u{e0041}",
  "/",
  "\\",
  ".",
  " ",
  ":",
  "*",
  "e\u0301",
  "A\u030a",
  "\u1100\u1161",
  "ß",
  "€",
  "日本",
  "😀",
  "👩‍👩‍👧",
  "con",
  "LPT1",
  ".pdf",
);
const names = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 400 }),
  fc.string({ unit: "binary", maxLength: 400 }),
  fc.string({ unit: tricky, maxLength: 120 }),
  fc
    .string({ unit: fc.oneof(tricky, fc.string({ unit: "grapheme", maxLength: 3 })) })
    .map((s) => s.normalize("NFD")),
);
const types = fc.constantFrom(
  "application/pdf",
  "text/plain",
  "application/octet-stream",
  "image/png",
);

function assertSafe(safe) {
  assert.ok(safe.length > 0, "not empty");
  assert.ok(Buffer.byteLength(safe) <= nameBytes, "at most 180 bytes");
  assert.ok(!forbidden.test(safe), "no separator, control or Windows-forbidden");
  assert.ok(!safe.startsWith("."), "not hidden");
  assert.ok(!/[ .]$/.test(safe), "no trailing dot or space");
  assert.ok(!hasHiddenCharacters(safe), "no hidden characters");
  assert.equal(safe, safe.normalize("NFC"));
  assert.ok(!reserved.test(safe), "no reserved device name");
  assert.ok(!/^\.{1,2}$/.test(safe));
}

test("a safe name never escapes, hides or names a reserved file", () => {
  fc.assert(
    fc.property(names, types, (name, type) => {
      const safe = safeFileName(name, type);
      assertSafe(safe);
      // Stable: a safe name stays as it is.
      assert.equal(safeFileName(safe, type), safe);
    }),
    { numRuns: 2000 },
  );
});

test("a numbered name stays safe and keeps the extension", () => {
  fc.assert(
    fc.property(names, types, fc.integer({ min: 2, max: 9999 }), (name, type, n) => {
      const safe = safeFileName(name, type);
      const numbered = numberedName(safe, n);
      assertSafe(numbered);
      assert.notEqual(numbered, safe);
      assert.ok(numbered.includes(` (${n})`));
    }),
  );
});

test("examples", () => {
  assert.equal(safeFileName("../../.zshrc", "text/plain"), "zshrc");
  assert.equal(safeFileName("CON.txt", "text/plain"), "_CON.txt");
  assert.equal(safeFileName("lpt9", "text/plain"), "_lpt9");
  assert.equal(safeFileName("", "application/pdf"), "attachment.pdf");
  assert.equal(safeFileName(null, "application/octet-stream"), "attachment");
  assert.equal(safeFileName("...", "text/plain"), "attachment.txt");
  assert.equal(
    safeFileName("Rechnung\u202efdp.exe", "application/pdf"),
    "Rechnungfdp.exe",
  );
  assert.equal(safeFileName("C:\\Users\\x\\report.pdf", "application/pdf"), "report.pdf");
  assert.equal(safeFileName('a<b>c:"d|e?f*.txt', "text/plain"), "a_b_c__d_e_f_.txt");
  assert.equal(safeFileName("Bericht. ", "application/octet-stream"), "Bericht");
  assert.equal(safeFileName("Cafe\u0301.pdf", "application/pdf"), "Café.pdf");
  assert.equal(safeFileName("invoice", "application/pdf"), "invoice");
  const long = safeFileName(`${"ä".repeat(200)}.pdf`, "application/pdf");
  assert.ok(Buffer.byteLength(long) <= nameBytes);
  assert.ok(long.endsWith(".pdf") && long.startsWith("ää"));
  assert.equal(numberedName("a.pdf", 1), "a.pdf");
  assert.equal(numberedName("a.pdf", 2), "a (2).pdf");
  assert.equal(numberedName("archive.tar.gz", 3), "archive.tar (3).gz");
  assert.equal(numberedName("README", 2), "README (2)");
  const numbered = numberedName(long, 12);
  assert.ok(Buffer.byteLength(numbered) <= nameBytes && numbered.endsWith(" (12).pdf"));
});
