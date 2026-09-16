import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";
import { extractionZip, extractOperation } from "../helpers/file-extract.js";

for (const target of ["", "subdir"]) {
  test(`archive Extract Here publishes files and nested folders at ${target || "project root"}`, async (t) => {
    const f = await uploadFixture(t);
    if (target) await fs.mkdir(path.join(f.project, target));
    await fs.writeFile(
      path.join(f.project, "input.zip"),
      extractionZip([
        { name: "hello.txt", bytes: "hello" },
        { name: "nested/child.txt", bytes: "child" },
      ]),
    );
    const job = await f.jobs.start(f.projectScope, extractOperation("input.zip", target));
    const done = await f.jobs.join(f.projectScope, job.id);
    assert.equal(done.status, "completed", JSON.stringify(done.issue));
    assert.equal(
      await fs.readFile(path.join(f.project, target, "hello.txt"), "utf8"),
      "hello",
    );
    assert.equal(
      await fs.readFile(path.join(f.project, target, "nested/child.txt"), "utf8"),
      "child",
    );
  });
}
