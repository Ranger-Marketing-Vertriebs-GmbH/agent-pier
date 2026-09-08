import { isMainModule } from "../server/lib/is-main-module.js";
import fs from "node:fs";
import path from "node:path";
import { releaseManifest } from "../server/features/operations/release-archive.js";
export function channelManifest(directory) {
  const records = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".aprelease.json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name))));
  if (!records.length) throw Error("No packaged releases were found.");
  const version = records[0].manifest.version,
    artifacts = {};
  for (const record of records) {
    releaseManifest(record.manifest, record.manifest.platform);
    if (record.manifest.version !== version || artifacts[record.manifest.platform])
      throw Error("Release versions or platforms conflict.");
    artifacts[record.manifest.platform] = {
      file: record.file,
      sha256: record.sha256,
      bytes: record.bytes,
    };
  }
  return { version, schemaVersion: 1, releasedAt: new Date().toISOString(), artifacts };
}
if (isMainModule(import.meta.url)) {
  const directory = path.resolve(process.argv[2] || ".");
  fs.writeFileSync(
    path.join(directory, "latest.json"),
    JSON.stringify(channelManifest(directory), null, 2) + "\n",
  );
}
