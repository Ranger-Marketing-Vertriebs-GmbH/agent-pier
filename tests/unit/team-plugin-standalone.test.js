import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The OpenClaw team plugin is copied alone into OpenClaw's plugin folder
// (team-plugin-install.js), so a relative import that leaves the folder cannot resolve.
const FOLDER = new URL("../../server/features/assistants/team-plugin/", import.meta.url)
  .pathname;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return full.endsWith(".js") ? [full] : [];
  });
}

test("team plugin imports stay inside its folder", () => {
  const escaping = [];
  for (const file of files(FOLDER)) {
    const text = fs.readFileSync(file, "utf8");
    const pattern =
      /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)(["'`])(\.{1,2}\/[^"'`]*)\1/g;
    for (const match of text.matchAll(pattern)) {
      const target = path.resolve(path.dirname(file), match[2]);
      if (path.relative(FOLDER, target).startsWith("..")) {
        escaping.push(`${path.relative(FOLDER, file)}: ${match[2]}`);
      }
    }
  }
  assert.deepEqual(escaping, [], "the plugin runs standalone in OpenClaw");
});
