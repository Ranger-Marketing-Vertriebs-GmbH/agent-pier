import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// node-pty 1.x npm prebuilts may lose executable mode in package archives.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("node-pty/package.json"));
  for (const relative of [
    `prebuilds/darwin-${process.arch}/spawn-helper`,
    "build/Release/spawn-helper",
  ]) {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }
}
