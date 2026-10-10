import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { issueGatewayCertificate } from "../../server/features/assistants/gateway-tls.js";

// Random serials whose leading byte is zero used to produce a non-minimal DER
// INTEGER that OpenSSL rejects (ERR_OSSL_ASN1_ILLEGAL_PADDING), so about one start
// in 256 failed with ENDPOINT_UNTRUSTED.
test("every serial number encodes as a valid minimal DER integer", () => {
  const serials = [
    [0x00, 0x10, 0xaa],
    [0x00, 0x00, 0x00, 0x7f],
    [0x00, 0x80, 0x01],
    [0x80, 0x01],
    [0x7f, 0xff],
    [0x00],
    [0x00, 0x00],
  ];
  for (const bytes of serials) {
    const { cert } = issueGatewayCertificate({ serial: Buffer.from(bytes) });
    const parsed = new X509Certificate(cert);
    const value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
    assert.equal(BigInt(`0x${parsed.serialNumber}`), value);
  }
});

test("an empty serial number is refused", () => {
  assert.throws(() => issueGatewayCertificate({ serial: Buffer.alloc(0) }), /serial/i);
});

test("issued certificates are self-signed for loopback and parse every time", () => {
  for (let index = 0; index < 64; index++) {
    const { cert } = issueGatewayCertificate();
    const parsed = new X509Certificate(cert);
    assert.equal(parsed.checkIP("127.0.0.1"), "127.0.0.1");
    assert.equal(parsed.verify(parsed.publicKey), true);
  }
});

// Certificates are regenerated on every start and valid for one year; dates from
// 2050 on use GeneralizedTime, so they never wrap to 1950.
test("certificates are valid for a year from issuance, also across 2050", () => {
  const day = 24 * 60 * 60 * 1000;
  for (const at of [
    "2026-10-09T00:00:00Z",
    "2049-06-01T00:00:00Z",
    "2051-01-01T00:00:00Z",
  ]) {
    const now = new Date(at);
    const parsed = new X509Certificate(issueGatewayCertificate({ now }).cert);
    assert.equal(Date.parse(parsed.validFrom), +now - day, at);
    assert.equal(Date.parse(parsed.validTo), +now + 365 * day, at);
    assert.equal(parsed.verify(parsed.publicKey), true, at);
  }
});
