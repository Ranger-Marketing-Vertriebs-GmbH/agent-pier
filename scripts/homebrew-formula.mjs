import fs from "node:fs";
import path from "node:path";
import { installerVersion } from "./installer-package.mjs";
import { isMainModule } from "../server/lib/is-main-module.js";

export function renderInstallerFormula({ version, file, sha256 }) {
  installerVersion(version);
  if (file !== `agentpier-installer-${version}.tar.gz`)
    throw Error("Unexpected installer bundle filename.");
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
    throw Error("Invalid installer checksum.");
  return fs
    .readFileSync(
      new URL("../packaging/homebrew/agentpier-installer.rb.in", import.meta.url),
      "utf8",
    )
    .replaceAll("@@VERSION@@", version)
    .replaceAll("@@FILE@@", file)
    .replaceAll("@@SHA256@@", sha256);
}
if (isMainModule(import.meta.url)) {
  const directory = path.resolve(process.argv[2] || "release-artifacts");
  const { version, bundle } = JSON.parse(
    fs.readFileSync(path.join(directory, "installer.json")),
  );
  const output = path.join(directory, "agentpier-installer.rb");
  fs.writeFileSync(output, renderInstallerFormula({ version, ...bundle }));
  fs.chmodSync(output, 0o644);
}
