import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";

export const registryUrl = "http://registry.test";
// A valid SRI shape (sha512 is 64 bytes: 86 base64 characters plus "==").
export const integrity = `sha512-${"A".repeat(86)}==`;
export const lockOf = (resolved = `${registryUrl}/x/-/x-1.0.0.tgz`) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/x": { version: "1.0.0", resolved, integrity } },
  });
export const packument = {
  name: "x",
  "dist-tags": { latest: "1.0.0" },
  versions: { "1.0.0": { bin: { x: "index.js" }, dist: { integrity } } },
};

/** In-memory stand-ins for the server store, its package records and the changes. */
export function harness(
  t,
  {
    toolchainDir,
    failSwitch = false,
    afterCommit,
    beforeSwitch,
    ciOutput,
    onCi,
    onResolve,
    adapters,
  } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-packages-unit-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const rows = new Map([
    [
      "s1",
      { id: "s1", transport: "stdio", command: "own", args: ["--flag"], revision: 1 },
    ],
  ]);
  const map = new Map();
  const records = {
    get: (id) => (map.has(id) ? { ...map.get(id) } : null),
    put: (id, fields) => map.set(id, { serverId: id, ...fields }),
    update: (id, fields) => map.has(id) && map.set(id, { ...map.get(id), ...fields }),
    remove: (id) => map.delete(id),
    all: () => [...map.values()].map((row) => ({ ...row })),
    installIds: () => new Set([...map.values()].map((r) => r.installId).filter(Boolean)),
  };
  const servers = {
    packages: records,
    get: (id) => ({ ...rows.get(id), source: records.get(id) ?? undefined }),
  };
  const switches = [];
  const changes = {
    update: async (id, patch) => {
      await beforeSwitch?.(id, patch);
      switches.push({ patch, record: records.get(id) });
      if (failSwitch) throw Object.assign(Error("conflict"), { status: 500 });
      rows.set(id, { ...rows.get(id), ...patch, revision: rows.get(id).revision + 1 });
      await afterCommit?.();
    },
  };
  const npmCalls = [];
  const execute = async (_node, args, options) => {
    const { cwd } = options;
    npmCalls.push(args[1]);
    if (args.includes("--package-lock-only")) await onResolve?.(options);
    if (args.includes("--package-lock-only"))
      fs.writeFileSync(path.join(cwd, "package-lock.json"), lockOf());
    if (args[1] === "ci") {
      await onCi?.(options);
      const dir = path.join(cwd, "node_modules", "x");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dir, "index.js"), "");
      return { stdout: ciOutput?.(cwd) ?? "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const service = new McpPackages({
    dataDir,
    servers,
    changes,
    registry: registryUrl,
    download: async () => Buffer.from(JSON.stringify(packument)),
    toolchain: async () => ({
      kind: "node",
      version: "22.0.0",
      directory:
        toolchainDir?.(dataDir) ?? path.join(dataDir, "toolchains", "node-v22.0.0-test"),
      nodePath: process.execPath,
      npmCliPath: "/npm-cli.js",
    }),
    execute,
    environment: {},
    ...(adapters ? { adapters } : {}),
  });
  return { dataDir, service, records, rows, switches, npmCalls };
}
export const source = { registry: "npm", name: "x", version: "1.0.0" };
export const attach = async (service) => {
  const { previewId } = await service.preview(source);
  return service.attach("s1", { source, previewId });
};
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
export const installEntries = (dataDir) =>
  fs.readdirSync(path.join(dataDir, "mcp-packages", "installs"));
