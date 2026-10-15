import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uvCertificateFile } from "../../server/features/mcp-packages/uv-certificates.js";

const pem = (body) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uv-ca-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the bundle is Node's roots plus the owner's CA, private to the run", (t) => {
  const dir = scratch(t);
  const extra = path.join(dir, "company.pem");
  fs.writeFileSync(extra, `junk\r\n${pem("COMPANY")}\r\n${pem("SECOND")}\n`);
  const file = uvCertificateFile(
    dir,
    { NODE_EXTRA_CA_CERTS: extra },
    { roots: [pem("ROOT")] },
  );
  assert.equal(path.dirname(file), dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    `${pem("ROOT")}\n${pem("COMPANY")}\n${pem("SECOND")}\n`,
  );
});

test("the default roots are Node's bundled root certificates", (t) => {
  const dir = scratch(t);
  const extra = path.join(dir, "company.pem");
  fs.writeFileSync(extra, pem("COMPANY"));
  const text = fs.readFileSync(
    uvCertificateFile(dir, { NODE_EXTRA_CA_CERTS: extra }),
    "utf8",
  );
  const count = text.match(/-----BEGIN CERTIFICATE-----/g).length;
  assert.ok(count > 100, String(count));
  assert.ok(text.endsWith(`${pem("COMPANY")}\n`));
});

test("without NODE_EXTRA_CA_CERTS uv keeps its own roots", (t) => {
  const dir = scratch(t);
  assert.equal(uvCertificateFile(dir, {}), null);
  assert.equal(uvCertificateFile(dir, { NODE_EXTRA_CA_CERTS: "" }), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an unusable extra CA file leaves uv on its own roots", (t) => {
  const dir = scratch(t);
  const errors = t.mock.method(console, "error", () => {});
  const big = path.join(dir, "big.pem");
  fs.writeFileSync(big, pem("x".repeat(1024 * 1024)));
  const empty = path.join(dir, "empty.pem");
  fs.writeFileSync(empty, "no certificates here");
  const values = [path.join(dir, "missing.pem"), dir, big, empty];
  for (const value of values)
    assert.equal(uvCertificateFile(dir, { NODE_EXTRA_CA_CERTS: value }), null, value);
  assert.equal(errors.mock.callCount(), values.length);
  const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.ok(!logged.includes(dir), logged);
  assert.ok(!fs.existsSync(path.join(dir, "ca-bundle.pem")));
});
