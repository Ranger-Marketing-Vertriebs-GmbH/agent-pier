import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const directory = new URL("../../web/features/assistants/", import.meta.url);
test("assistant styles take colours from theme variables", async () => {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".css"));
  assert.ok(files.length >= 2);
  for (const file of files) {
    const css = await readFile(new URL(file, directory), "utf8");
    assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], file);
    assert.deepEqual(
      css.match(/var\(--[\w-]+\)\s*\d+/g) ?? [],
      [],
      `${file} alpha suffix`,
    );
  }
});
