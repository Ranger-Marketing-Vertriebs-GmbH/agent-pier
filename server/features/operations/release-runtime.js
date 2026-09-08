import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download } from "./releases.js";
import { digest } from "./files.js";
import { problem } from "../../lib/storage.js";
const execute = promisify(execFile);
export const NODE_RUNTIME_VERSION = "22.22.2";
export async function prepareReleaseRuntime(
  directory,
  { platform = `${process.platform}-${process.arch}`, fetchImpl = fetch } = {},
) {
  if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(platform))
    throw problem("Unsupported release runtime platform.");
  const basename = `node-v${NODE_RUNTIME_VERSION}-${platform}`,
    file = `${basename}.tar.gz`,
    base = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/`;
  const sums = (await download(`${base}SHASUMS256.txt`, fetchImpl, 1024 * 1024)).toString(
    "utf8",
  );
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === file)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw problem("Official Node checksum is missing.");
  const bytes = await download(base + file, fetchImpl, 128 * 1024 * 1024);
  if (digest(bytes) !== expected)
    throw problem("Official Node runtime checksum mismatch.");
  const archive = path.join(directory, file);
  fs.writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
  try {
    const { stdout: license } = await execute(
      "tar",
      ["-xOzf", archive, `${basename}/LICENSE`],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: "buffer" },
    );
    if (!license.length) throw problem("Official Node runtime license is missing.");
    fs.writeFileSync(path.join(directory, "node-LICENSE.txt"), license, {
      flag: "wx",
      mode: 0o600,
    });
    await execute(
      "tar",
      [
        "-xzf",
        archive,
        "-C",
        directory,
        "--strip-components",
        "2",
        `${basename}/bin/node`,
      ],
      { timeout: 30000, maxBuffer: 32768 },
    );
    const node = path.join(directory, "node"),
      stat = fs.lstatSync(node);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw problem("Invalid extracted Node runtime.");
    fs.chmodSync(node, 0o755);
    return node;
  } finally {
    fs.rmSync(archive, { force: true });
  }
}
