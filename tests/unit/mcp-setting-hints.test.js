import test from "node:test";
import assert from "node:assert/strict";
import {
  addressWarnings,
  isSecretName,
  isWriteSwitch,
  secretCount,
  settingProblem,
  storedCount,
  writeSwitch,
} from "../../web/features/mcp-servers/wizard/setting-hints.js";

const row = (name, value = "", extra = {}) => ({ key: name, name, value, ...extra });

test("secret names are masked by the name heuristic", () => {
  for (const name of [
    "API_KEY",
    "github_token",
    "DB_PASSWORD",
    "AUTH",
    "PRIVATE_PEM",
    "x-credential",
  ])
    assert.equal(isSecretName(name), true, name);
  for (const name of ["OPNSENSE_URL", "VERIFY_SSL", "PORT"])
    assert.equal(isSecretName(name), false, name);
});

test("a write switch is found by name or description", () => {
  assert.equal(isWriteSwitch("OPNSENSE_ALLOW_WRITES"), true);
  assert.equal(isWriteSwitch("READ_ONLY"), true);
  assert.equal(isWriteSwitch("READONLY"), true);
  assert.equal(isWriteSwitch("MODE", "Set READWRITE to allow changes"), true);
  assert.equal(isWriteSwitch("WRITE_ENABLED"), true);
  assert.equal(isWriteSwitch("OPNSENSE_URL", "Address"), false);
});

test("the write switch state reads off, on or stored; read-only switches are inverted", () => {
  assert.deepEqual(writeSwitch([row("OPNSENSE_ALLOW_WRITES", "false")]), {
    name: "OPNSENSE_ALLOW_WRITES",
    state: "off",
  });
  assert.equal(writeSwitch([row("OPNSENSE_ALLOW_WRITES", "")]).state, "off");
  assert.equal(writeSwitch([row("OPNSENSE_ALLOW_WRITES", "TRUE")]).state, "on");
  assert.equal(writeSwitch([row("READ_ONLY", "true")]).state, "off");
  assert.equal(writeSwitch([row("READ_ONLY", "0")]).state, "on");
  assert.equal(writeSwitch([row("ALLOW_WRITES", "", { stored: true })]).state, "stored");
  assert.equal(writeSwitch([row("ALLOW_WRITES", "1", { stored: true })]).state, "on");
  assert.equal(
    writeSwitch([row("ALLOW_WRITES", "", { stored: true, removed: true })]),
    null,
  );
  assert.equal(writeSwitch([row("URL", "x")]), null);
});

test("setting problems follow the server's limits", () => {
  const env = (r, extra = {}) => settingProblem(r, { kind: "env", rows: [r], ...extra });
  assert.equal(env(row("TOKEN", ""), { required: true }), "requiredEmpty");
  assert.equal(env(row("TOKEN", "", { stored: true }), { required: true }), null);
  assert.equal(env(row("TOKEN", "${GITHUB_TOKEN}")), "reference");
  assert.equal(env(row("1TOKEN", "x")), "envName");
  assert.equal(env(row("MY-TOKEN", "x")), "envName");
  assert.equal(env(row("TOKEN", "a\nb")), "lineBreak");
  assert.equal(env(row("TOKEN", "x".repeat(16385))), "tooLong");
  assert.equal(env(row("TOKEN", "ok")), null);
  assert.equal(
    settingProblem(row("X Header", "v"), {
      kind: "header",
      rows: [row("X Header", "v")],
    }),
    "headerName",
  );
  const twice = [row("A", "1"), { ...row("A", "2"), key: "other" }];
  assert.equal(settingProblem(twice[1], { kind: "env", rows: twice }), "duplicate");
  assert.equal(env(row("", "")), null);
});

test("names the server refuses as object keys are refused here too", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    assert.equal(settingProblem(row(name, "x"), { kind: "env", rows: [] }), "envName");
    assert.equal(
      settingProblem(row(name, "x"), { kind: "header", rows: [] }),
      "headerName",
    );
  }
});

test("address warnings: unencrypted non-loopback hosts and token-like query parameters", () => {
  assert.deepEqual(addressWarnings("http://example.test/mcp"), ["insecure"]);
  assert.deepEqual(addressWarnings("http://127.0.0.1:8080/mcp"), []);
  assert.deepEqual(addressWarnings("http://localhost/mcp"), []);
  assert.deepEqual(addressWarnings("http://[::1]/mcp"), []);
  assert.deepEqual(addressWarnings("https://x.test/mcp?api_key=abc"), ["tokenInQuery"]);
  assert.deepEqual(addressWarnings("https://x.test/mcp?page=2"), []);
  assert.deepEqual(addressWarnings("nonsense"), []);
});

test("counts for the summary and Done", () => {
  const rows = [
    row("A", "1"),
    row("B", "", { stored: true }),
    row("C", "", { stored: true, removed: true }),
    row("", "x"),
    row("TOKEN", "t"),
  ];
  assert.equal(storedCount(rows), 3);
  assert.equal(secretCount(rows, { settings: { A: { secret: true } } }), 2);
});
