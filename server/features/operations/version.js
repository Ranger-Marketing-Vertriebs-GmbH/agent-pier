import fs from "node:fs";
import { fileURLToPath } from "node:url";
export const applicationRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function applicationVersion() {
  const release = new URL("../../../release.json", import.meta.url);
  const source = new URL("../../../package.json", import.meta.url);
  return JSON.parse(fs.readFileSync(fs.existsSync(release) ? release : source, "utf8"))
    .version;
}
