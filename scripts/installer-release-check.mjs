import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  installerLimits,
  installerVersion,
  renderOnlineInstaller,
} from "./installer-package.mjs";
import { renderInstallerFormula } from "./homebrew-formula.mjs";
import { isMainModule } from "../server/lib/is-main-module.js";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

export async function validateInstallerRelease({ directory, tag }) {
  const read = async (file, limit) => {
    const target = path.join(directory, file),
      stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw Error(`Invalid release file or size: ${file}`);
    return fs.readFile(target);
  };
  const latestBytes = await read("latest.json", 1024 * 1024);
  const installerBytes = await read("installer.json", 1024 * 1024);
  const latest = JSON.parse(latestBytes),
    installer = JSON.parse(installerBytes);
  installerVersion(installer.version);
  if (
    latest.version !== installer.version ||
    tag !== `v${installer.version}` ||
    latest.schemaVersion !== 1
  )
    throw Error("Release tag and asset versions differ.");
  if (
    !latest.artifacts ||
    Object.keys(latest.artifacts).sort().join() !== platforms.slice().sort().join()
  )
    throw Error("All four platform artifacts are required.");
  const files = [];
  const check = async (record, file, limit) => {
    if (
      !record ||
      record.file !== file ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > limit
    )
      throw Error(`Invalid release metadata: ${file}`);
    const bytes = await read(file, limit);
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256)
      throw Error(`Release checksum or size mismatch: ${file}`);
    files.push({ file, sha256: record.sha256, bytes: bytes.length });
    return bytes;
  };
  for (const platform of platforms)
    await check(
      latest.artifacts[platform],
      `agentpier-${platform}.aprelease`,
      768 * 1024 * 1024,
    );
  await check(
    installer.bundle,
    `agentpier-installer-${installer.version}.tar.gz`,
    installerLimits.compressed,
  );
  const script = await check(
    installer.script,
    "install-agentpier.sh",
    installerLimits.script,
  );
  if (
    script.toString() !==
    renderOnlineInstaller({ version: installer.version, sha256: installer.bundle.sha256 })
  )
    throw Error("Installer script content does not match its release.");
  const formula = await read("agentpier-installer.rb", 256 * 1024);
  if (
    formula.toString() !==
    renderInstallerFormula({ version: installer.version, ...installer.bundle })
  )
    throw Error("Homebrew formula does not match its release.");
  for (const [file, bytes] of [
    ["latest.json", latestBytes],
    ["installer.json", installerBytes],
    ["agentpier-installer.rb", formula],
  ])
    files.push({ file, sha256: digest(bytes), bytes: bytes.length });
  return files;
}
if (isMainModule(import.meta.url))
  console.log(
    JSON.stringify(
      await validateInstallerRelease({
        directory: path.resolve(process.argv[2] || "release-artifacts"),
        tag: process.argv[3] || process.env.RELEASE_TAG,
      }),
    ),
  );
