import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliMcpFixture } from "./cli-mcp.js";
import { pypiIndexFixture } from "./pypi-index-fixture.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { ensureToolchain } from "../../server/features/mcp-packages/toolchains.js";

const executeFile = promisify(execFile);

/** One real managed toolchain (uv + CPython) per machine, outside the test data dirs. */
export const sharedToolchains = path.join(os.tmpdir(), "agentpier-test-toolchains");
export const sharedPython = () =>
  ensureToolchain("python", { dataDir: sharedToolchains });

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
