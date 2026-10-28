import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentLimits,
  decodedRaw,
  decodeTransfer,
  partInfo,
} from "../../server/features/mail/mail-parts.js";

test("decodeTransfer decodes base64, quoted-printable and 8bit", () => {
  assert.equal(decodeTransfer(Buffer.from("SGVs\r\nbG8="), "base64").toString(), "Hello");
  assert.equal(
    decodeTransfer(Buffer.from("Gr=C3=BC=\r\nße"), "quoted-printable").toString(),
    "Grüße",
  );
  assert.equal(decodeTransfer(Buffer.from("x"), "8bit").toString(), "x");
  assert.throws(() => decodeTransfer(Buffer.from("x"), "x-uuencode"), {
    code: "MAIL_PROTOCOL",
  });
});

test("decodeTransfer keeps binary bytes and malformed escapes, ignores case", () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  assert.deepEqual(decodeTransfer(bytes, "binary"), bytes);
  assert.deepEqual(decodeTransfer(bytes, "7BIT"), bytes);
  assert.deepEqual(decodeTransfer(bytes, undefined), bytes);
  assert.equal(
    decodeTransfer(Buffer.from("a=ZZb=3D=\nc"), "Quoted-Printable").toString(),
    "a=ZZb=c",
  );
  assert.equal(decodeTransfer(Buffer.from(" SGk=\n"), " BASE64 ").toString(), "Hi");
});

test("decodedRaw decodes a raw part by its own transfer encoding", () => {
  const raw = Buffer.from(
    'Content-Type: application/pdf; name="a.pdf"\r\nContent-Transfer-Encoding:\r\n base64\r\n\r\nJVBE\r\nRi0=',
  );
  assert.equal(decodedRaw(raw).toString("latin1"), "%PDF-");
  assert.equal(
    decodedRaw(Buffer.from("Content-Type: text/csv\r\n\r\na,b")).toString(),
    "a,b",
  );
});

test("partInfo estimates the decoded size of a base64 part", () => {
  assert.deepEqual(
    partInfo({
      part: "2",
      type: "application/pdf",
      encoding: "base64",
      size: 400,
      dispositionParameters: { filename: "a.pdf" },
      parameters: { charset: "utf-8" },
    }),
    {
      part: "2",
      name: "a.pdf",
      type: "application/pdf",
      size: 300,
      encoding: "base64",
      charset: "utf-8",
    },
  );
  assert.deepEqual(partInfo({ size: 10 }), {
    part: "1",
    name: null,
    type: "application/octet-stream",
    size: 10,
    encoding: "7bit",
    charset: null,
  });
});

test("the limits are 25 MB per mail and per file, 20 files", () => {
  assert.deepEqual(attachmentLimits, {
    mailBytes: 26_214_400,
    fileBytes: 26_214_400,
    files: 20,
  });
  assert.ok(Object.isFrozen(attachmentLimits));
});
