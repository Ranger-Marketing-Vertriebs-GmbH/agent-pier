import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  NODE_RUNTIME_VERSION,
  prepareReleaseRuntime,
} from "../../server/features/operations/release-runtime.js";
import { digest } from "../../server/features/operations/files.js";

async function fixture(t, { license = true, checksum = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-runtime-license-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basename = `node-v${NODE_RUNTIME_VERSION}-linux-x64`;
  const source = path.join(root, basename);
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.writeFile(path.join(source, "bin/node"), "fixture runtime");
  if (license)
    await fs.writeFile(path.join(source, "LICENSE"), "Node notice\nThird-party notice\n");
  const archive = path.join(root, "runtime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, basename]);
  const bytes = await fs.readFile(archive);
  const directory = path.join(root, "unpacked");
  await fs.mkdir(directory);
  const fetchImpl = async (url) =>
    new Response(
      url.endsWith("SHASUMS256.txt")
        ? `${checksum ? digest(bytes) : "0".repeat(64)}  ${basename}.tar.gz\n`
        : bytes,
    );
  return { directory, fetchImpl };
}

test("verified runtime extraction retains its exact third-party license text", async (t) => {
  const { directory, fetchImpl } = await fixture(t);
  const node = await prepareReleaseRuntime(directory, {
    platform: "linux-x64",
    fetchImpl,
  });
  assert.equal(await fs.readFile(node, "utf8"), "fixture runtime");
  assert.equal(
    await fs.readFile(path.join(directory, "node-LICENSE.txt"), "utf8"),
    "Node notice\nThird-party notice\n",
  );
});

test("a verified runtime archive without its license is rejected", async (t) => {
  const { directory, fetchImpl } = await fixture(t, { license: false });
  await assert.rejects(
    prepareReleaseRuntime(directory, { platform: "linux-x64", fetchImpl }),
  );
});

test("runtime checksum rejection happens before extracting license or binary", async (t) => {
  const { directory, fetchImpl } = await fixture(t, { checksum: false });
  await assert.rejects(
    prepareReleaseRuntime(directory, { platform: "linux-x64", fetchImpl }),
    /checksum mismatch/,
  );
  assert.deepEqual(await fs.readdir(directory), []);
});
