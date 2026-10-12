import fs from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  decodeArchive,
  encodeArchive,
} from "../../server/features/operations/archive.js";
import {
  CAPSULE_NAME,
  HEADER_NAME,
  SCHEMA_VERSION,
} from "../../server/features/operations/archive-v2.js";
import {
  endOfArchive,
  fileHeader,
  padding,
  parseHeader,
  parsePax,
} from "../../server/features/operations/tar.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A small backup archive of either version, in memory, as one object: `{ format,
 * version, manifest, files: [{ path, content(base64), sha256, mode }],
 * credentials? }`. Test helper only: the server reads archives as streams.
 */
export function loadArchive(fileOrBytes) {
  const bytes = Buffer.isBuffer(fileOrBytes) ? fileOrBytes : fs.readFileSync(fileOrBytes);
  const raw = gunzipSync(bytes);
  if (raw[0] === 0x7b) return decodeArchive(bytes);
  let offset = 0;
  const take = (size) => {
    const data = raw.subarray(offset, offset + size);
    offset += size + padding(size).length;
    return data;
  };
  const entries = [];
  for (;;) {
    let header = parseHeader(raw.subarray(offset, offset + 512));
    offset += 512;
    if (!header) break;
    let name = header.name;
    if (header.type === "x") {
      name = parsePax(take(header.size));
      header = parseHeader(raw.subarray(offset, offset + 512));
      offset += 512;
    }
    entries.push({ name, data: take(header.size) });
  }
  const [first, ...rest] = entries;
  if (first?.name !== HEADER_NAME) throw new Error("not a version 2 archive");
  const header = JSON.parse(first.data);
  const files = [];
  let credentials;
  for (const entry of rest) {
    if (entry.name === CAPSULE_NAME) credentials = JSON.parse(entry.data);
    else
      files.push({
        path: entry.name,
        content: entry.data.toString("base64"),
        sha256: sha256(entry.data),
        mode: 0o600,
      });
  }
  return {
    format: header.format,
    version: header.version,
    manifest: header.manifest,
    files,
    ...(credentials ? { credentials } : {}),
  };
}

/**
 * Encodes a loaded (possibly altered) archive as version 2 bytes. Member `sha256`
 * values are kept as given, so a test can declare a wrong one.
 */
export function encodeArchiveV2(archive) {
  const members = archive.files.map((file) => ({
    path: file.path,
    data: Buffer.from(file.content, "base64"),
    sha256: file.sha256,
    kind: file.path.startsWith("sealed/") ? "sealed" : "public",
  }));
  if (archive.credentials) {
    const data = Buffer.from(JSON.stringify(archive.credentials));
    members.unshift({
      path: CAPSULE_NAME,
      data,
      sha256: sha256(data),
      kind: "credentials",
    });
  }
  const header = Buffer.from(
    JSON.stringify({
      format: "agentpier-backup",
      version: 2,
      manifest: { ...archive.manifest, schemaVersion: SCHEMA_VERSION },
      members: members.map((m) => ({
        path: m.path,
        size: m.data.length,
        sha256: m.sha256 ?? sha256(m.data),
        mode: 0o600,
        kind: m.kind,
      })),
    }),
  );
  const parts = [fileHeader(HEADER_NAME, header.length), header, padding(header.length)];
  for (const m of members)
    parts.push(fileHeader(m.path, m.data.length), m.data, padding(m.data.length));
  parts.push(endOfArchive());
  return gzipSync(Buffer.concat(parts));
}

/** Encodes a loaded archive in the original version 1 JSON format. */
export function encodeArchiveV1(archive) {
  return encodeArchive({
    ...archive,
    format: "agentpier-backup",
    version: 1,
    manifest: { ...archive.manifest, schemaVersion: 1 },
  });
}

/** Every byte an archive holds as text, for checks that a value never appears. */
export function archiveText(fileOrBytes) {
  const bytes = Buffer.isBuffer(fileOrBytes) ? fileOrBytes : fs.readFileSync(fileOrBytes);
  const archive = loadArchive(bytes);
  return [
    gunzipSync(bytes).toString("latin1"),
    ...archive.files.map((m) => Buffer.from(m.content, "base64").toString("latin1")),
  ].join("\n");
}
