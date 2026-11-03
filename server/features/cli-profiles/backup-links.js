import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { assetDirectories } from "./assets.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

// Logical backups omit external native profiles. Recognize only the exact links
// produced by sharing; other symbolic links still fail the backup boundary check.
export function sharedAssetLinks(dataDir, home) {
  const state = readJSON(path.join(dataDir, "shared-cli-profiles.json"), {});
  const accounts = readJSON(path.join(dataDir, "accounts.json"), []);
  const links = new Set();
  for (const account of accounts) {
    if (!state[account.id] || !isCodingCli(account.tool)) continue;
    const { nativeFolder: native } = cliDriver(account.tool).profileFiles;
    const relative = account.provider
      ? path.join("providers", account.provider.id, native)
      : native;
    const canonical = path.join(home, `.${native}`);
    for (const name of assetDirectories(account.tool)) {
      const file = path.join(dataDir, "profiles", account.id, relative, name);
      try {
        if (
          fs.lstatSync(file).isSymbolicLink() &&
          path.resolve(path.dirname(file), fs.readlinkSync(file)) ===
            path.join(canonical, name)
        )
          links.add(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return links;
}
