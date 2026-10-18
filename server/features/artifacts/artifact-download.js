import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import yazl from "yazl";
import { attachmentHeaders } from "../files/file-downloads.js";
import { artifactError } from "./artifact-errors.js";
import { safeBundlePath } from "./artifact-source.js";

/**
 * Reads an artifact's stored copies without following links: every stored name is the
 * file's index, and a copy that is no longer a regular file of the recorded size is
 * refused rather than served.
 */
export async function readArtifactFiles(folder, files) {
  const read = [];
  for (const file of files) {
    if (!safeBundlePath(file.path) || !/^\d{1,3}$/.test(file.stored))
      throw artifactError("ARTIFACT_IO_ERROR", 500);
    const handle = await fs.open(
      path.join(folder, file.stored),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.size)
        throw artifactError("ARTIFACT_IO_ERROR", 500);
      const bytes = await handle.readFile();
      if (bytes.length !== file.size) throw artifactError("ARTIFACT_IO_ERROR", 500);
      read.push({ path: file.path, mediaType: file.mediaType, bytes });
    } finally {
      await handle.close();
    }
  }
  return read;
}

// A file name from the artifact's title: no separators, reserved or control characters.
export function artifactFileName(title, extension) {
  const base =
    String(title)
      .replace(/[\p{Cc}/\\:*?"<>|]+/gu, "_")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 100) || "artifact";
  return base.toLowerCase().endsWith(extension.toLowerCase())
    ? base
    : `${base}${extension}`;
}

async function zipped(files, mtime) {
  const zip = new yazl.ZipFile();
  for (const file of files)
    zip.addBuffer(file.bytes, file.path, {
      mtime,
      mode: 0o100644,
      // Raster images are already compressed; text, SVG and fonts shrink.
      compress: !/^image\/(?!svg)/.test(file.mediaType),
    });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * What a download sends: the original file for a single-file artifact (an image or one
 * page), otherwise a zip of the artifact's file tree.
 */
export async function artifactDownload({ title, updatedAt, files }) {
  if (files.length === 1) {
    const [file] = files;
    return {
      name: artifactFileName(title, path.extname(file.path)),
      mediaType: file.mediaType.startsWith("image/")
        ? file.mediaType
        : "application/octet-stream",
      body: file.bytes,
    };
  }
  return {
    name: artifactFileName(title, ".zip"),
    mediaType: "application/zip",
    body: await zipped(files, new Date(updatedAt)),
  };
}

export function sendArtifactDownload(response, download) {
  attachmentHeaders(response, download.name, download.body.length);
  response.setHeader("Content-Type", download.mediaType);
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.end(download.body);
}
