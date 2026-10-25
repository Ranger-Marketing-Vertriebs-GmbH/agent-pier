import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SECRET_HEADER,
  secretEnvFile,
  writeSecretFile,
} from "../../server/features/secrets/secret-format.js";

const tricky = "it's $HOME `id` \\ \nline2";

test("the env file is sorted, has a header and survives sh byte for byte", () => {
  const text = secretEnvFile([
    { name: "B", value: "x" },
    { name: "A", value: tricky },
  ]);
  assert.ok(text.startsWith(`${SECRET_HEADER}\n`));
  assert.ok(text.endsWith("\n"));
  assert.ok(text.indexOf("\nA=") < text.indexOf("\nB="));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-format-"));
  try {
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, text);
    const read = (name) =>
      execFileSync(
        "sh",
        ["-c", `set -a; . "$1"; set +a; printf %s "$${name}"`, "_", file],
        { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent" } },
      );
    assert.equal(read("A"), tricky);
    assert.equal(read("B"), "x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty list renders as an empty string", () => {
  assert.equal(secretEnvFile([]), "");
});

test("writeSecretFile writes 0600 in a 0700 folder, skips identical content and removes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-format-"));
  try {
    const file = path.join(dir, "nested", "secrets.env");
    const entries = [{ name: "A", value: "1" }];
    assert.equal(await writeSecretFile(file, entries), "written");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(await writeSecretFile(file, entries), "unchanged");
    assert.equal(await writeSecretFile(file, [{ name: "A", value: "2" }]), "written");
    assert.equal(await writeSecretFile(file, []), "removed");
    assert.equal(fs.existsSync(file), false);
    assert.equal(await writeSecretFile(file, []), "unchanged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSecretFile refuses a symlinked parent folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-format-"));
  try {
    const target = path.join(dir, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dir, "link"));
    await assert.rejects(
      writeSecretFile(path.join(dir, "link", "secrets.env"), [{ name: "A", value: "1" }]),
    );
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
