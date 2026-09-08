import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateMembers } from "./archive.js";
import { readFile, folder, digest, atomic } from "./files.js";
import { problem } from "../../lib/storage.js";
const execute = promisify(execFile);
export const RELEASE_LIMIT = 768 * 1024 * 1024;
export function releaseVersion(value) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value) ||
    value.length > 80
  )
    throw problem("Invalid release version.");
  return value;
}
export function releaseManifest(value, platform = `${process.platform}-${process.arch}`) {
  releaseVersion(value?.version);
  if (
    !["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(platform) ||
    value.platform !== platform ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.schemaMin) ||
    !Number.isSafeInteger(value.schemaMax) ||
    value.schemaMin > 1 ||
    value.schemaMax < 1
  )
    throw problem("Release platform or data schema is incompatible.", 409);
  return value;
}
export function unpackRelease(bytes, target, platform) {
  if (bytes.length > RELEASE_LIMIT)
    throw problem("Release download exceeds its limit.", 413);
  let value;
  try {
    value = JSON.parse(gunzipSync(bytes, { maxOutputLength: RELEASE_LIMIT }));
  } catch {
    throw problem("Invalid release archive.");
  }
  if (value?.format !== "agentpier-release" || value.version !== 1)
    throw problem("Unsupported release archive.");
  const manifest = releaseManifest(value.manifest, platform);
  validateMembers(value.files, { executable: true, limit: RELEASE_LIMIT });
  for (const required of [
    "release.json",
    "bin/node",
    "server/index.js",
    "package.json",
    "dist/index.html",
    "node_modules/node-pty/package.json",
  ])
    if (!value.files.some((member) => member.path === required))
      throw problem(`Release layout is missing ${required}.`);
  const embedded = value.files.find((member) => member.path === "release.json");
  if (
    JSON.stringify(JSON.parse(Buffer.from(embedded.content, "base64"))) !==
    JSON.stringify(manifest)
  )
    throw problem("Release manifests disagree.");
  for (const member of value.files) {
    const file = path.join(target, member.path);
    folder(path.dirname(file));
    fs.writeFileSync(file, Buffer.from(member.content, "base64"), {
      flag: "wx",
      mode: member.mode,
    });
  }
  return manifest;
}
export async function smokeRelease(directory) {
  try {
    await execute(
      path.join(directory, "bin/node"),
      [
        "--input-type=module",
        "-e",
        "await import('node-pty'); await import('node:sqlite'); await import('./server/app.js');",
      ],
      {
        cwd: directory,
        timeout: 15000,
        maxBuffer: 32768,
        env: {
          PATH: `${path.join(directory, "bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: directory,
        },
      },
    );
  } catch (cause) {
    throw Object.assign(
      problem("Release runtime or native dependency smoke check failed."),
      { cause },
    );
  }
}
export function packageRelease({
  source,
  node = process.execPath,
  nodeLicense = path.join(path.dirname(node), "node-LICENSE.txt"),
  output,
  version,
  platform = `${process.platform}-${process.arch}`,
}) {
  source = fs.realpathSync(source);
  const manifest = releaseManifest({
    version: releaseVersion(version),
    platform,
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
  });
  const files = [],
    seen = new Set();
  let total = 0;
  const add = (relative, file, mode) => {
    const content = readFile(file, RELEASE_LIMIT);
    total += content.length;
    if (total > RELEASE_LIMIT / 1.5)
      throw problem("Release payload exceeds its limit.", 413);
    files.push({
      path: relative,
      content: content.toString("base64"),
      sha256: digest(content),
      mode,
    });
  };
  const walk = (relative, ancestors = new Set()) => {
    const original = path.join(source, relative),
      actual = fs.realpathSync(original);
    if (actual !== source && !actual.startsWith(`${source}${path.sep}`))
      throw problem("Release payload link escapes its source.");
    const st = fs.statSync(actual);
    if (st.isDirectory()) {
      if (ancestors.has(actual))
        throw problem("Release payload contains a directory cycle.");
      for (const child of fs.readdirSync(actual).sort()) {
        if (relative === "node_modules" && child === ".bin") continue;
        walk(`${relative}/${child}`, new Set([...ancestors, actual]));
      }
    } else if (!seen.has(relative)) {
      seen.add(relative);
      add(relative, actual, st.mode & 0o111 ? 0o755 : 0o600);
    }
  };
  for (const relative of [
    "server",
    "vendor",
    "dist",
    "node_modules",
    "scripts",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    walk(relative);
  add("third-party/node-LICENSE.txt", fs.realpathSync(nodeLicense), 0o600);
  add("bin/node", fs.realpathSync(node), 0o755);
  const content = Buffer.from(JSON.stringify(manifest));
  files.push({
    path: "release.json",
    content: content.toString("base64"),
    sha256: digest(content),
    mode: 0o600,
  });
  const archive = gzipSync(
    Buffer.from(
      JSON.stringify({ format: "agentpier-release", version: 1, manifest, files }),
    ),
  );
  atomic(output, archive);
  return {
    file: path.basename(output),
    sha256: digest(archive),
    bytes: archive.length,
    manifest,
  };
}
