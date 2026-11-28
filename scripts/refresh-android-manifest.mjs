import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isMainModule } from "../server/lib/is-main-module.js";

// Maintainer operation only: computes the entries of
// server/features/devices/android-manifest.js for one pin. Google's repository index
// names each archive with its size and SHA-1 only, so this script downloads every
// pinned archive (or takes it from `--archives <dir>`), requires the index's size and
// SHA-1, and then computes what the manifest pins: the SHA-256, the top-level folder,
// the number of files and the expanded size. Nothing is unpacked: the numbers come
// from the zip's directory. An archive whose SHA-1 differs from the index is refused
// and nothing is printed.
export const repository = "https://dl.google.com/android/repository/";
export const indexes = {
  tools: "repository2-3.xml",
  images: "sys-img/google_apis/sys-img2-3.xml",
};
export const pin = {
  emulator: "37.3.10",
  platformTools: "37.0.3",
  image: { api: 36, tag: "google_apis", revision: 7 },
};
// Manifest platform key -> how the index names that host, and the image it runs.
export const hosts = {
  "darwin-arm64": { os: "macosx", arch: "aarch64", abi: "arm64-v8a" },
  "linux-x64": { os: "linux", arch: "x64", abi: "x86_64" },
};

const text = (xml, tag) =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml)?.[1].trim() ?? null;

/**
 * The packages of one repository index: `[{ path, revision, licence, archives }]`,
 * an archive being `{ url, size, sha1, os, arch }` with `os` and `arch` null where
 * the index names none (system images run on every host).
 */
export function parseIndex(xml) {
  const packages = [];
  for (const [, packagePath, body] of xml.matchAll(
    /<remotePackage\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g,
  )) {
    const revision = /<revision>([\s\S]*?)<\/revision>/.exec(body)?.[1] ?? "";
    const archives = [];
    for (const [, archive] of body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const complete = /<complete>([\s\S]*?)<\/complete>/.exec(archive)?.[1] ?? "";
      archives.push({
        url: text(complete, "url"),
        size: Number(text(complete, "size")),
        sha1: /<checksum(?:\s+type="sha1")?>([a-f0-9]{40})<\/checksum>/.exec(
          complete,
        )?.[1],
        os: text(archive, "host-os"),
        arch: text(archive, "host-arch"),
      });
    }
    packages.push({
      path: packagePath,
      revision: ["major", "minor", "micro"]
        .map((part) => text(revision, part))
        .filter((part) => part !== null)
        .join("."),
      licence: /<uses-license\s+ref="([^"]+)"/.exec(body)?.[1] ?? null,
      archives,
    });
  }
  return { packages };
}

/**
 * The one archive of package `path` at `revision` for a host: `{ url, size, sha1,
 * licence }`. Throws when the index does not list that revision or has no (or more
 * than one) archive for the host.
 */
export function pick(index, { path: packagePath, revision, os: hostOs, arch }) {
  const found = index.packages.find(
    (entry) => entry.path === packagePath && entry.revision === String(revision),
  );
  if (!found)
    throw Error(`The index does not list ${packagePath} at revision ${revision}.`);
  const archives = found.archives.filter(
    (archive) =>
      (!archive.os || archive.os === hostOs) && (!archive.arch || archive.arch === arch),
  );
  if (archives.length !== 1)
    throw Error(
      `${packagePath} ${revision}: ${archives.length} archives for ${hostOs} ${arch}.`,
    );
  const [{ url, size, sha1 }] = archives;
  if (!url || !Number.isSafeInteger(size) || size <= 0 || !sha1)
    throw Error(`${packagePath} ${revision}: the archive entry is incomplete.`);
  return { url, size, sha1, licence: found.licence };
}

/** What the pin needs from the two indexes: `[{ component, key, base, ...pick() }]`. */
export function pinnedArchives({ tools, images }, keys = Object.keys(hosts)) {
  const { api, tag, revision } = pin.image;
  return keys.flatMap((key) => {
    const host = hosts[key];
    if (!host) throw Error(`Unknown platform ${key}.`);
    const from = (component, index, base, query) => ({
      component,
      key,
      base,
      ...pick(index, { ...query, os: host.os, arch: host.arch }),
    });
    return [
      from("emulator", tools, repository, { path: "emulator", revision: pin.emulator }),
      from("platformTools", tools, repository, {
        path: "platform-tools",
        revision: pin.platformTools,
      }),
      {
        ...from("image", images, new URL(".", repository + indexes.images).href, {
          path: `system-images;android-${api};${tag};${host.abi}`,
          revision,
        }),
        abi: host.abi,
      },
    ];
  });
}

async function digests(file) {
  const sha1 = createHash("sha1"),
    sha256 = createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    sha1.update(chunk);
    sha256.update(chunk);
    size += chunk.length;
  }
  return { size, sha1: sha1.digest("hex"), sha256: sha256.digest("hex") };
}

// The zip's directory: the single top-level folder, the files and their sizes.
async function contents(file) {
  const { open } = await import("yauzl");
  return new Promise((resolve, reject) => {
    open(file, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const tops = new Set();
      let files = 0,
        expandedBytes = 0;
      zip.on("error", reject);
      zip.on("end", () => {
        if (tops.size !== 1)
          return reject(Error(`${file}: ${tops.size} top-level folders.`));
        resolve({ top: [...tops][0], files, expandedBytes });
      });
      zip.on("entry", (entry) => {
        tops.add(entry.fileName.split("/")[0]);
        if (!entry.fileName.endsWith("/")) {
          files++;
          expandedBytes += entry.uncompressedSize;
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

/**
 * The manifest entry of one archive file, `{ url, sha256, size, top, expandedBytes,
 * files }`. Throws unless the file has the index's size and SHA-1.
 */
export async function manifestEntry(file, { url, size, sha1 }) {
  const actual = await digests(file);
  if (actual.size !== size || actual.sha1 !== sha1)
    throw Error(
      `${path.basename(file)}: ${actual.size} bytes with SHA-1 ${actual.sha1}, the ` +
        `index names ${size} bytes with SHA-1 ${sha1}. Nothing is printed for it.`,
    );
  return { url, sha256: actual.sha256, size, ...(await contents(file)) };
}

async function download(url, file, fetchImpl) {
  if (new URL(url).protocol !== "https:") throw Error(`Not an HTTPS address: ${url}`);
  const response = await fetchImpl(url, { redirect: "error" });
  if (response.status !== 200 || !response.body)
    throw Error(`${url}: HTTP ${response.status}`);
  const handle = await fsp.open(file, "wx", 0o600);
  try {
    for await (const chunk of response.body) await handle.write(chunk);
  } finally {
    await handle.close();
  }
}

/**
 * The manifest entries for the pin, as `{ emulator, platformTools, image }`, each
 * `{ "<platform>": entry }`, plus the licence ids the pinned packages reference.
 * `archives` names a folder whose files (by archive name) are used instead of a
 * download; `index` names a folder holding the two index files by their base names.
 */
export async function refreshAndroidManifest({
  archives = null,
  index = null,
  keys = Object.keys(hosts),
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "android-manifest-"));
  try {
    const readIndex = async (name) => {
      if (index) return fsp.readFile(path.join(index, path.basename(name)), "utf8");
      const response = await fetchImpl(repository + name, { redirect: "error" });
      if (response.status !== 200)
        throw Error(`${repository + name}: HTTP ${response.status}`);
      return response.text();
    };
    const wanted = pinnedArchives(
      {
        tools: parseIndex(await readIndex(indexes.tools)),
        images: parseIndex(await readIndex(indexes.images)),
      },
      keys,
    );
    const result = { emulator: {}, platformTools: {}, image: {}, licences: [] };
    for (const { component, key, base, abi, licence, ...archive } of wanted) {
      const url = base + archive.url;
      const local = archives && path.join(archives, path.basename(archive.url));
      let file = local && fs.existsSync(local) ? local : null;
      if (!file) {
        file = path.join(temporary, path.basename(archive.url));
        log(`Downloading ${url} (${archive.size} bytes)`);
        await download(url, file, fetchImpl);
      } else log(`Using ${file}`);
      const entry = await manifestEntry(file, { ...archive, url });
      result[component][key] = abi ? { ...entry, abi } : entry;
      if (licence && !result.licences.includes(licence)) result.licences.push(licence);
      if (file !== local) await fsp.rm(file, { force: true });
    }
    return result;
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const usage =
    "Usage: node scripts/refresh-android-manifest.mjs [--archives <dir>] " +
    "[--index <dir>] [--platform darwin-arm64|linux-x64]...";
  const options = { keys: [] };
  const args = process.argv.slice(2);
  while (args.length) {
    const [flag, value] = args.splice(0, 2);
    if (!value) throw Error(usage);
    if (flag === "--archives") options.archives = path.resolve(value);
    else if (flag === "--index") options.index = path.resolve(value);
    else if (flag === "--platform") options.keys.push(value);
    else throw Error(usage);
  }
  if (!options.keys.length) delete options.keys;
  console.log(
    JSON.stringify(
      await refreshAndroidManifest({ ...options, log: (line) => console.error(line) }),
      null,
      2,
    ),
  );
}
