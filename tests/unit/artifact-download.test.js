import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactDownload,
  artifactFileName,
  readArtifactFiles,
} from "../../server/features/artifacts/artifact-download.js";
import { downloadName } from "../../web/features/artifacts/artifact-download.js";
import { zipEntries } from "../helpers/file-archives.js";

async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-artifact-download-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const generation = path.join(root, "generation");
  await fs.mkdir(generation);
  await fs.writeFile(path.join(root, "secret"), "outside");
  return { root, generation };
}
const row = (file, size, stored = "0") => ({
  path: file,
  mediaType: "text/html",
  size,
  stored,
});

test("stored artifact files are read without following links or leaving the generation", async (t) => {
  const { root, generation } = await folder(t);
  await fs.writeFile(path.join(generation, "0"), "<p>ok</p>");
  assert.deepEqual(
    (await readArtifactFiles(generation, [row("index.html", 9)])).map((file) => [
      file.path,
      file.bytes.toString(),
    ]),
    [["index.html", "<p>ok</p>"]],
  );
  await fs.symlink(path.join(root, "secret"), path.join(generation, "1"));
  await assert.rejects(readArtifactFiles(generation, [row("a.html", 7, "1")]), {
    code: "ELOOP",
  });
  for (const [file, stored] of [
    ["../secret", "0"],
    ["/etc/passwd", "0"],
    ["a/../../b.html", "0"],
    ["index.html", "../secret"],
  ])
    await assert.rejects(readArtifactFiles(generation, [row(file, 7, stored)]), {
      code: "ARTIFACT_IO_ERROR",
    });
  // A copy whose size no longer matches the record is refused.
  await assert.rejects(readArtifactFiles(generation, [row("index.html", 3)]), {
    code: "ARTIFACT_IO_ERROR",
  });
});

test("download names come from the title without separators or reserved characters", async () => {
  assert.equal(artifactFileName("Report", ".html"), "Report.html");
  assert.equal(artifactFileName("report.HTML", ".html"), "report.HTML");
  assert.equal(artifactFileName("../../etc/passwd", ".zip"), "_.._etc_passwd.zip");
  assert.equal(artifactFileName('a:b*c?"d"<e>|f\\g', ".png"), "a_b_c_d_e_f_g.png");
  assert.equal(artifactFileName("  ...  ", ".zip"), "artifact.zip");
  assert.equal(artifactFileName("Résumé 2026", ".zip"), "Résumé 2026.zip");
  const zipped = await artifactDownload({
    title: "Site",
    updatedAt: "2026-10-18T10:00:00.000Z",
    files: [
      { path: "index.html", mediaType: "text/html", bytes: Buffer.from("<p>") },
      { path: "img/a.png", mediaType: "image/png", bytes: Buffer.from([1, 2]) },
    ],
  });
  assert.equal(zipped.name, "Site.zip");
  assert.deepEqual([...(await zipEntries(zipped.body)).keys()].sort(), [
    "img/a.png",
    "index.html",
  ]);
});

test("the browser reads the RFC 5987 file name first", () => {
  assert.equal(
    downloadName(
      `attachment; filename="Bericht f_r M_rz.html"; filename*=UTF-8''Bericht%20f%C3%BCr%20M%C3%A4rz.html`,
      "artifact",
    ),
    "Bericht für März.html",
  );
  assert.equal(downloadName(`attachment; filename="plain.zip"`, "artifact"), "plain.zip");
  assert.equal(
    downloadName(`attachment; filename="x.zip"; filename*=UTF-8''%E0%A4%A`, "y"),
    "x.zip",
  );
  assert.equal(downloadName(null, "artifact"), "artifact");
});
