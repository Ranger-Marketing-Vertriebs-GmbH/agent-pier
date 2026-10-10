import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualificationDirectory } from "../../scripts/verify-assistant-runtime.mjs";
test("qualification rejects existing application data and symlink targets", (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "assistant-qualification-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "settings.json"), "{}");
  assert.throws(() => qualificationDirectory(live), /empty/);
  const link = path.join(root, "alias");
  fs.symlinkSync(live, link);
  assert.throws(() => qualificationDirectory(link), /symlink/);
  assert.throws(() => qualificationDirectory("relative"), /absolute/);
  const clean = path.join(root, "probe");
  assert.equal(qualificationDirectory(clean), clean);
  fs.mkdirSync(path.join(clean, "speech"));
  assert.equal(qualificationDirectory(clean), clean);
  fs.writeFileSync(path.join(clean, "settings.json"), "{}");
  assert.throws(() => qualificationDirectory(clean), /empty/);
});
