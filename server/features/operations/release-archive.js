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
        `
          await import('node-pty');
          await import('node:sqlite');
          await import('./server/app.js');
          const fs = await import('node:fs');
          const path = await import('node:path');
          const { createRequire } = await import('node:module');
          const root = fs.realpathSync(process.cwd());
          const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
          if (pkg.dependencies?.koffi) {
            const require = createRequire(path.join(root, 'package.json'));
            const nativePackage = '@koromix/koffi-' + process.platform + '-' + process.arch;
            const within = (file, parent) => file.startsWith(parent + path.sep);
            for (const name of ['koffi', nativePackage]) {
              const entry = fs.realpathSync(require.resolve(name));
              if (!within(entry, path.join(root, 'node_modules', name)))
                throw Error('Native package resolves outside this release.');
              require(name);
            }
            const nativeRoot = path.join(root, 'node_modules', nativePackage);
            if (!Object.keys(require.cache).some(file =>
              file.endsWith('.node') && within(fs.realpathSync(file), nativeRoot)))
              throw Error('Native platform binary is missing from this release.');
            const { FileNative } = await import('./server/features/files/file-native.js');
            const native = new FileNative();
            try {
              const directory = await native.run('openRoot', { path: root });
              const file = await native.run('openFile', { directory: directory.handle, path: 'package.json' });
              const bytes = await native.run('read', { handle: file.handle, length: 64, position: 0 });
              if (!bytes.length) throw Error('Native descriptor read failed.');
            } finally { await native.close(); }
          }
        `,
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
