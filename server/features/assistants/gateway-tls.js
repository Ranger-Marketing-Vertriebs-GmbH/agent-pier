import fs from "node:fs";
import path from "node:path";
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { privateFolder } from "./runtime-paths.js";

// Minimal DER writer: Node can sign but not issue X.509 certificates, and the
// Gateway must not depend on an openssl binary being installed on the host.
function length(size) {
  if (size < 128) return Buffer.from([size]);
  const bytes = [];
  for (let rest = size; rest; rest >>= 8) bytes.unshift(rest & 255);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
function objectId(text) {
  const [first, second, ...rest] = text.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const encoded = [value & 127];
    for (let next = value >> 7; next; next >>= 7) encoded.unshift((next & 127) | 128);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
// DER INTEGERs are minimal: OpenSSL rejects a redundant leading zero byte.
function integer(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80))
    start++;
  const minimal = bytes.subarray(start);
  return der(
    0x02,
    minimal[0] & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal,
  );
}
// RFC 5280: UTCTime through 2049, GeneralizedTime from 2050 on.
function time(date) {
  const digits = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : der(0x18, Buffer.from(`${digits}Z`));
}
const ecdsaSha256 = sequence(objectId("1.2.840.10045.4.3.2"));
const name = sequence(
  der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from("agentpier-gateway")))),
);
const pem = (label, bytes) =>
  `-----BEGIN ${label}-----\n${bytes
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END ${label}-----\n`;

export function issueGatewayCertificate({
  now = new Date(),
  serial = randomBytes(16),
} = {}) {
  if (!serial.length) throw Error("Gateway certificate serial must not be empty.");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const day = 24 * 60 * 60 * 1000;
  // Regenerated on every start, so one year of validity suffices.
  const subjectAltName = sequence(
    objectId("2.5.29.17"),
    der(0x04, sequence(der(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const certificate = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaSha256,
    name,
    sequence(time(new Date(now - day)), time(new Date(+now + 365 * day))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(subjectAltName)),
  );
  const signature = sign("sha256", certificate, privateKey);
  const cert = pem(
    "CERTIFICATE",
    sequence(certificate, ecdsaSha256, der(0x03, Buffer.from([0]), signature)),
  );
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

function replacePrivate(file, content) {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

// A fresh pair on every start keeps rotation simple: the client re-reads the pin
// from this private folder for each connection and never learns it from the network.
export function prepareGatewayTls(paths) {
  const directory = privateFolder(path.join(paths.root, "tls"));
  const certPath = path.join(directory, "gateway-cert.pem");
  const keyPath = path.join(directory, "gateway-key.pem");
  const { cert, key } = issueGatewayCertificate();
  replacePrivate(keyPath, key);
  replacePrivate(certPath, cert);
  return { certPath, keyPath };
}

export function readGatewayPin(certPath) {
  const stat = fs.lstatSync(certPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw Object.assign(Error("Unsafe Gateway certificate."), { code: "TLS_PIN" });
  const cert = fs.readFileSync(certPath, "utf8");
  return { cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}
