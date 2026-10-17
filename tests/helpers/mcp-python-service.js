import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliMcpFixture } from "./cli-mcp.js";
import { pypiIndexFixture } from "./pypi-index-fixture.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { ensureToolchain } from "../../server/features/mcp-packages/toolchains.js";

const executeFile = promisify(execFile);

/** One real managed toolchain (uv + CPython) per machine, outside the test data dirs. */
// Downloaded once and kept across test runs, outside the runner's per-run temp folder.
export const sharedToolchains = path.join(
  process.env.AGENTPIER_TEST_SHARED_TMPDIR || os.tmpdir(),
  "agentpier-test-toolchains",
);
export const sharedPython = () =>
  ensureToolchain("python", { dataDir: sharedToolchains });

const setuptools = {
  file: "setuptools-84.0.0-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl",
  sha256: "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670",
};

/**
 * The build backend the sdists in the local index need, downloaded once next to the
 * shared toolchain and checked against its pinned digest (uv itself only ever talks
 * to the fixture index).
 */
export async function pinnedSetuptools() {
  const file = path.join(sharedToolchains, setuptools.file);
  const ok = (bytes) =>
    createHash("sha256").update(bytes).digest("hex") === setuptools.sha256;
  if (fs.existsSync(file) && ok(fs.readFileSync(file))) return file;
  let bytes;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(setuptools.url);
      if (!response.ok) throw Error(`setuptools download failed: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      // files.pythonhosted.org hiccups must not fail the gated build tests.
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  if (!ok(bytes)) throw Error("setuptools checksum mismatch");
  fs.mkdirSync(sharedToolchains, { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, file);
  return file;
}

/**
 * McpPackages over a local PyPI index with the managed uv and CPython. `calls` lists
 * the argument vector of every program the service ran (uv and the wheel reader).
 */
export async function pythonPackageService(t, published) {
  const python = await sharedPython();
  const index = await pypiIndexFixture(t, python, published);
  const f = cliMcpFixture(t);
  const changes = new CentralMcpChanges({ servers: f.servers });
  const calls = [];
  const packages = new McpPackages({
    dataDir: f.dataDir,
    servers: f.servers,
    changes,
    pypi: { api: index.api, index: index.index },
    environment: {},
    download: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(Error("x"), { status: response.status });
      return Buffer.from(await response.arrayBuffer());
    },
    toolchain: async (kind) => {
      if (kind !== "python") throw Error(`unexpected toolchain ${kind}`);
      return python;
    },
    execute: (file, args, options) => {
      calls.push(args);
      return executeFile(file, args, options);
    },
  });
  return { ...f, python, index, packages, calls };
}

export const pypiRef = (name, version = "1.0") => ({ registry: "pypi", name, version });

/** A packaged server created from a fresh preview, after its job settled. */
export async function createPython(s, name, extra = {}) {
  const preview = await s.packages.preview({ ...pypiRef(name), ...extra });
  const server = await s.packages.createServer(
    { name: `py-${name}`, transport: "stdio", source: { ...pypiRef(name), ...extra } },
    { previewId: preview.previewId },
  );
  await s.packages.jobs.idle();
  return { preview, server: s.servers.get(server.id) };
}
