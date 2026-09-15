import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { isMainModule } from "../server/lib/is-main-module.js";

export const installerLimits = {
  compressed: 16 * 1024 * 1024,
  expanded: 64 * 1024 * 1024,
  members: 10000,
  script: 256 * 1024,
};
export function installerVersion(version) {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
    version.length > 80
  )
    throw Error("Invalid installer version.");
  return version;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function safeName(name) {
  if (
    !/^[a-zA-Z0-9_@.+/-]+$/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw Error("Unsafe installer archive path.");
}
// Deterministic USTAR: no host ownership, timestamps, links, or extension records.
export function createInstallerTar(members) {
  if (members.length > installerLimits.members)
    throw Error("Installer member limit exceeded.");
  const parts = [],
    seen = new Set();
  let bytes = 1024;
  for (const { name, content, mode = 0o644 } of [...members].sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    safeName(name);
    if (seen.has(name)) throw Error("Duplicate installer archive path.");
    seen.add(name);
    let short = name,
      prefix = "";
    if (Buffer.byteLength(short) > 100) {
      const split = name.lastIndexOf("/");
      prefix = name.slice(0, split);
      short = name.slice(split + 1);
    }
    if (Buffer.byteLength(short) > 100 || Buffer.byteLength(prefix) > 155)
      throw Error("Installer archive path too long.");
    const data = Buffer.from(content);
    bytes += 512 + Math.ceil(data.length / 512) * 512;
    if (bytes > installerLimits.expanded)
      throw Error("Installer expanded size limit exceeded.");
    const header = Buffer.alloc(512);
    header.write(short, 0, 100);
    const octal = (value, offset, size) =>
      header.write(value.toString(8).padStart(size - 1, "0") + "\0", offset, size);
    octal(mode & 0o111 ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(prefix, 345, 155);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
export function renderOnlineInstaller({ version, sha256 }) {
  installerVersion(version);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error("Invalid installer checksum.");
  const template = fs.readFileSync(
    new URL("./install-online.sh.in", import.meta.url),
    "utf8",
  );
  const result = template
    .replaceAll("@@VERSION@@", version)
    .replaceAll("@@SHA256@@", sha256)
    .replace("@@SETUP_VALIDATION@@", () =>
      fs.readFileSync(new URL("./install-bootstrap.sh", import.meta.url), "utf8"),
    );
  if (Buffer.byteLength(result) > installerLimits.script)
    throw Error("Installer script size limit exceeded.");
  return result;
}
export async function buildInstaller({ source, outputDir, version }) {
  installerVersion(version);
  source = fs.realpathSync(source);
  if (JSON.parse(fs.readFileSync(path.join(source, "package.json"))).version !== version)
    throw Error("Installer and application version differ.");
  const names = execFileSync(
    "git",
    [
      "-C",
      source,
      "ls-files",
      "-z",
      "--",
      "package.json",
      "scripts",
      "server",
      "vendor",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const required of [
    "package.json",
    "scripts/setup.sh",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    if (!names.includes(required))
      throw Error(`Installer source missing tracked ${required}.`);
  const members = names.map((name) => {
    safeName(name);
    const file = path.join(source, name),
      stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(file) !== file ||
      stat.size > installerLimits.expanded
    )
      throw Error("Installer source must be bounded regular files without links.");
    return { name, content: fs.readFileSync(file), mode: stat.mode };
  });
  members.push({ name: "installer-version", content: Buffer.from(`${version}\n`) });
  const bundle = gzipSync(createInstallerTar(members), { level: 9 });
  if (bundle.length > installerLimits.compressed)
    throw Error("Installer compressed size limit exceeded.");
  const record = {
    file: `agentpier-installer-${version}.tar.gz`,
    sha256: digest(bundle),
    bytes: bundle.length,
  };
  const script = Buffer.from(renderOnlineInstaller({ version, sha256: record.sha256 }));
  const result = {
    version,
    bundle: record,
    script: {
      file: "install-agentpier.sh",
      sha256: digest(script),
      bytes: script.length,
    },
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, record.file), bundle);
  fs.writeFileSync(path.join(outputDir, result.script.file), script, { mode: 0o755 });
  fs.writeFileSync(
    path.join(outputDir, "installer.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
if (isMainModule(import.meta.url)) {
  const source = path.resolve(import.meta.dirname, "..");
  const version = JSON.parse(fs.readFileSync(path.join(source, "package.json"))).version;
  console.log(
    JSON.stringify(
      await buildInstaller({
        source,
        version,
        outputDir: path.resolve(process.argv[2] || "release-artifacts"),
      }),
      null,
      2,
    ),
  );
}
