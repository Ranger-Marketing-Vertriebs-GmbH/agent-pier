import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { viewImage } from "../../server/features/assistants/project-files.js";
import { MAX_INLINE_IMAGE_BYTES } from "../../server/features/assistants/agent-attachment-types.js";
import { jpegOf, png, webpOf } from "../helpers/image-bytes.js";

// A project folder with images, AgentPier's data dir inside it and a picture outside.
function host(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-image-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "app");
  const data = path.join(project, "agentpier-data");
  fs.mkdirSync(path.join(project, "shots"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(project, "shots", "home.png"), png);
  fs.writeFileSync(path.join(project, "shots", "photo.jpg"), jpegOf());
  fs.writeFileSync(path.join(project, "shots", "hero.webp"), webpOf());
  fs.writeFileSync(path.join(project, ".git", "logo.png"), png);
  fs.writeFileSync(path.join(data, "avatar.png"), png);
  fs.writeFileSync(path.join(base, "outside.png"), png);
  return { base, project, options: { protectedRoots: [data] } };
}
const refused = { status: 403, key: "projectPathRefused" };
const notImage = { status: 400, key: "projectImageUnsuitable" };

test("image_view returns PNG, JPEG and WebP files as base64 with their checked type", async (t) => {
  const h = host(t);
  for (const [file, type, bytes] of [
    ["shots/home.png", "image/png", png],
    ["shots/photo.jpg", "image/jpeg", jpegOf()],
    [path.join(h.project, "shots", "hero.webp"), "image/webp", webpOf()],
  ]) {
    const result = await viewImage(h.project, file, h.options);
    assert.equal(result.mimeType, type);
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.data, bytes.toString("base64"));
    assert.equal(result.path, path.relative(h.project, path.resolve(h.project, file)));
  }
  // The type comes from the bytes, never the name.
  fs.writeFileSync(path.join(h.project, "shots", "renamed.txt"), png);
  assert.equal(
    (await viewImage(h.project, "shots/renamed.txt", h.options)).mimeType,
    "image/png",
  );
});

test("image_view refuses other files, oversized images and HEIC", async (t) => {
  const h = host(t);
  fs.writeFileSync(path.join(h.project, "notes.md"), "# Notes\n");
  fs.writeFileSync(path.join(h.project, "doc.pdf"), "%PDF-1.7\n");
  fs.writeFileSync(
    path.join(h.project, "photo.heic"),
    Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic"),
      Buffer.alloc(4),
      Buffer.from("mif1heic"),
    ]),
  );
  for (const file of ["notes.md", "doc.pdf", "photo.heic"])
    await assert.rejects(viewImage(h.project, file, h.options), notImage);
  const big = path.join(h.project, "big.png");
  fs.writeFileSync(big, png);
  fs.truncateSync(big, MAX_INLINE_IMAGE_BYTES + 1);
  await assert.rejects(viewImage(h.project, "big.png", h.options), notImage);
  await assert.rejects(viewImage(h.project, "shots", h.options), {
    key: "projectFileUnsuitable",
  });
  await assert.rejects(viewImage(h.project, "missing.png", h.options), {
    status: 404,
  });
});

test("image_view stays inside the folder: no links out, hard links, .git or data", async (t) => {
  const h = host(t);
  fs.symlinkSync(path.join(h.base, "outside.png"), path.join(h.project, "link.png"));
  fs.symlinkSync(
    path.join(h.project, "shots", "home.png"),
    path.join(h.project, "in.png"),
  );
  fs.linkSync(path.join(h.base, "outside.png"), path.join(h.project, "hard.png"));
  for (const raw of [
    "link.png",
    "../outside.png",
    path.join(h.base, "outside.png"),
    ".git/logo.png",
    "agentpier-data/avatar.png",
  ])
    await assert.rejects(viewImage(h.project, raw, h.options), refused, raw);
  await assert.rejects(viewImage(h.project, "hard.png", h.options), {
    key: "projectFileUnsuitable",
  });
  // A link that stays inside the folder shows its target.
  assert.equal((await viewImage(h.project, "in.png", h.options)).mimeType, "image/png");
});
