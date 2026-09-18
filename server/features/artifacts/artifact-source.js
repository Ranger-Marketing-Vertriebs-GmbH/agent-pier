import fs from "node:fs/promises";
import path from "node:path";
import { FileNative, nativeReadBytes } from "../files/file-native.js";
import { artifactError } from "./artifact-errors.js";
const types = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const invalid = () => artifactError("ARTIFACT_INVALID_SOURCE");
export const safeBundlePath = (name) =>
  typeof name === "string" &&
  name.length <= 1024 &&
  /^[\w./ -]+$/.test(name) &&
  !name.startsWith("/") &&
  name.split("/").every((p) => p && p !== "." && p !== "..");
export async function copyArtifactSource(
  context,
  input,
  destination,
  limits,
  availableBytes,
) {
  const native = new FileNative();
  let sizeBytes = 0,
    visited = 0;
  const files = [];
  const names = new Set();
  try {
    if (
      typeof input.sourcePath !== "string" ||
      !input.sourcePath ||
      input.sourcePath.includes("\0") ||
      input.sourcePath.split(/[\\/]/).includes("..")
    )
      throw invalid();
    const cwd = await fs.realpath(context.cwd);
    const absolute = path.resolve(context.cwd, input.sourcePath);
    const relative = path.relative(path.resolve(context.cwd), absolute);
    if (!safeBundlePath(relative)) throw invalid();
    const root = await native.run("openRoot", { path: cwd });
    const selectedParent = await native.run("openLookup", {
      directory: root.handle,
      path: path.dirname(relative) === "." ? "" : path.dirname(relative),
    });
    async function copy(parent, name, output, depth) {
      if (++visited > 1500 || depth > 32 || !safeBundlePath(output)) throw invalid();
      const info = await native.run("inspect", { directory: parent, name });
      if (info.type === "directory") {
        const lookup = await native.run("openLookup", { directory: parent, path: name });
        const stream = await native.run("openDirectory", {
          directory: lookup.handle,
          path: "",
        });
        try {
          let entry;
          while ((entry = await native.run("readDirectory", { handle: stream.handle })))
            await copy(
              lookup.handle,
              entry.name,
              output ? `${output}/${entry.name}` : entry.name,
              depth + 1,
            );
        } finally {
          await native.run("closeHandle", { handle: stream.handle });
          await native.run("closeHandle", { handle: lookup.handle });
        }
        return;
      }
      if (info.type !== "file" || info.nlink !== 1n || names.has(output.toLowerCase()))
        throw invalid();
      const mediaType = types[path.extname(output).toLowerCase()];
      if (!mediaType) throw invalid();
      if (
        files.length >= limits.files ||
        info.size > BigInt(limits.publicationBytes - sizeBytes)
      )
        throw artifactError("ARTIFACT_LIMIT_EXCEEDED", 413);
      names.add(output.toLowerCase());
      const opened = await native.run("openFile", { directory: parent, path: name });
      const stored = `${files.length}`;
      const target = await fs.open(path.join(destination, stored), "wx", 0o600);
      let length = 0;
      try {
        const before = await native.run("stat", { handle: opened.handle });
        if (before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1n)
          throw invalid();
        for (;;) {
          const chunk = await native.run("read", {
            handle: opened.handle,
            length: nativeReadBytes,
            position: length,
          });
          if (!chunk.length) break;
          length += chunk.length;
          sizeBytes += chunk.length;
          if (sizeBytes > limits.publicationBytes || sizeBytes > availableBytes)
            throw artifactError("ARTIFACT_LIMIT_EXCEEDED", 413);
          await target.writeFile(chunk);
        }
        const after = await native.run("stat", { handle: opened.handle });
        if (
          ["size", "mtimeNs", "ctimeNs", "nlink"].some(
            (key) => after[key] !== before[key],
          ) ||
          BigInt(length) !== after.size
        )
          throw artifactError("ARTIFACT_SOURCE_CHANGED", 409);
        await target.sync();
      } finally {
        await target.close();
        await native.run("closeHandle", { handle: opened.handle });
      }
      files.push({ path: output, mediaType, size: length, stored });
    }
    const leaf = path.basename(relative);
    const selected = await native.run("inspect", {
      directory: selectedParent.handle,
      name: leaf,
    });
    let entrypoint;
    if (selected.type === "directory") {
      if (!safeBundlePath(input.entrypoint)) throw invalid();
      const lookup = await native.run("openLookup", {
        directory: selectedParent.handle,
        path: leaf,
      });
      const stream = await native.run("openDirectory", {
        directory: lookup.handle,
        path: "",
      });
      try {
        let entry;
        while ((entry = await native.run("readDirectory", { handle: stream.handle })))
          await copy(lookup.handle, entry.name, entry.name, 0);
      } finally {
        await native.run("closeHandle", { handle: stream.handle });
        await native.run("closeHandle", { handle: lookup.handle });
      }
      entrypoint = input.entrypoint;
    } else {
      if (input.entrypoint !== undefined && input.entrypoint !== leaf) throw invalid();
      await copy(selectedParent.handle, leaf, leaf, 0);
      entrypoint = leaf;
    }
    const entry = files.find((file) => file.path === entrypoint);
    if (
      !entry ||
      !(
        entry.mediaType === "text/html" ||
        (selected.type !== "directory" && entry.mediaType.startsWith("image/"))
      )
    )
      throw invalid();
    return { files, entrypoint, sizeBytes, mediaType: entry.mediaType };
  } finally {
    await native.close();
  }
}
