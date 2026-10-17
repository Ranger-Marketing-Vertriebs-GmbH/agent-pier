import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { setup, environment } from "../helpers/repositories.js";

const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// A git that speaks German unless its caller pins the C locale, as Homebrew git
// does on a German macOS even without LANG. Pinned, it runs the real git (or
// prints `english` for a failure) and records the locale it was given.
function localizedGit(t, { german, english } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-locale-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const capture = path.join(dir, "locale.jsonl");
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { LC_ALL, LANGUAGE } = process.env;
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ LC_ALL, LANGUAGE }) + "\\n");
if (LC_ALL !== "C") {
  process.stderr.write(${JSON.stringify(german || "Schwerwiegend: Kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git\n")});
  process.exit(128);
}
if (${JSON.stringify(english || "")}) {
  process.stderr.write(${JSON.stringify(english || "")});
  process.exit(128);
}
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  environment(t, {
    PATH: `${bin}:${process.env.PATH}`,
    LANGUAGE: "de",
    LC_ALL: undefined,
  });
  const calls = () =>
    fs
      .readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { dir, calls };
}

test("a plain folder stays a directory project when git speaks German", async (t) => {
  const { dir, calls } = localizedGit(t);
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  const scope = await projectScope(plain);
  assert.equal(scope.kind, "directory");
  assert.equal(scope.cwd, plain);
  const repository = path.join(dir, "repository");
  execFileSync(realGit, ["init", "-q", repository]);
  assert.equal((await projectScope(repository)).kind, "git");
  assert.deepEqual(calls(), [
    { LC_ALL: "C", LANGUAGE: "C" },
    { LC_ALL: "C", LANGUAGE: "C" },
  ]);
});

test("clone failures are classified when git speaks German", async (t) => {
  const { calls } = localizedGit(t, {
    german:
      "Schwerwiegend: Authentifizierung fehlgeschlagen für 'https://github.com/a/b/'\n",
    english: "fatal: Authentication failed for 'https://github.com/a/b/'\n",
  });
  const { store, dir } = setup(t);
  await assert.rejects(
    store.clone({
      url: "https://github.com/a/b.git",
      parentDirectory: dir,
      folderName: "denied",
    }),
    { message: serverMessages.repositories.cloneAuthenticationFailed },
  );
  assert.deepEqual(calls(), [{ LC_ALL: "C", LANGUAGE: "C" }]);
  await store.close();
});
