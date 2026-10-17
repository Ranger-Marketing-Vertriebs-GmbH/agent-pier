import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliMcpFixture } from "./cli-mcp.js";
import { hostNode, npmRegistryFixture } from "./npm-registry-fixture.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { toolchainRoot } from "../../server/features/mcp-packages/toolchains.js";
import { mcpServerConfig } from "../../server/features/assistants/openclaw-config/mcp-servers.js";

const executeFile = promisify(execFile);

export const v1 = {
  name: "server-x",
  version: "1.0.0",
  bin: { "server-x": "index.js" },
  files: { "index.js": "" },
  dependencies: { helper: "1.0.0" },
};
export const v2 = { ...v1, version: "2.0.0", dependencies: { helper: "2.0.0" } };
const helpers = [
  { name: "helper", version: "1.0.0", files: { "i.js": "" } },
  { name: "helper", version: "2.0.0", files: { "i.js": "" } },
];
export const program =
  /mcp-packages\/installs\/[0-9a-f-]{36}\/node_modules\/server-x\/index\.js$/;
export const ref = (version = "1.0.0") => ({
  registry: "npm",
  name: "server-x",
  version,
});
/** A stored package record before its first install. */
export const stored = (extra = {}) => ({
  ...ref(),
  program: "server-x",
  programPath: "index.js",
  allowScripts: false,
  lock: "{}",
  lockDigest: "d".repeat(64),
  integrity: "sha512-x",
  installId: null,
  leadingArgs: 0,
  toolchainDir: null,
  status: "installing",
  errorCode: null,
  ...extra,
});
export const installsOf = (dataDir) =>
  fs.readdirSync(path.join(dataDir, "mcp-packages", "installs"));
const deferred = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

/**
 * The real server store, central changes and CLI reconciler (temporary HOME and data
 * dir, cliMcpFixture) with McpPackages over a local npm registry. The host Node is
 * the toolchain: its binary is linked into the fixture root (the store accepts only
 * commands there), and it reports a `node-*` folder under the data dir's toolchains.
 * `hold()` makes the next install job wait for `release()` before npm runs.
 * After every stored change, `saved` gets what the CLIs and the agents saw then.
 */
export async function packageService(t, published = [v1, v2, ...helpers]) {
  const registry = await npmRegistryFixture(t, published);
  const f = cliMcpFixture(t);
  const bin = path.join(f.root, "toolchain", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const nodePath = path.join(bin, "node");
  fs.symlinkSync(process.execPath, nodePath);
  const node = {
    kind: "node",
    version: "host",
    directory: path.join(toolchainRoot(f.dataDir), "node-vhost"),
    ...hostNode(),
    nodePath,
  };
  const saved = [];
  const changes = new CentralMcpChanges({
    servers: f.servers,
    onSaved: async () => {
      const claude = f.reconciler.reconcile("claude");
      const agents = Object.fromEntries(
        f.servers
          .definitions()
          .map((d) => [d.name, mcpServerConfig(d, f.servers.secrets(d.id))]),
      );
      saved.push({ definitions: f.servers.definitions(), claude, agents });
    },
  });
  const calls = [];
  let gate = null;
  const packages = new McpPackages({
    dataDir: f.dataDir,
    servers: f.servers,
    changes,
    extensions: f.extensions,
    registry: registry.url,
    environment: {},
    download: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(Error("x"), { status: response.status });
      return Buffer.from(await response.arrayBuffer());
    },
    toolchain: async () => node,
    execute: async (file, args, options) => {
      calls.push(args);
      if (args.includes("ci") && gate) {
        const held = gate;
        gate = null;
        held.reached.open();
        await held.promise;
      }
      return executeFile(file, args, options);
    },
  });
  return {
    ...f,
    registry,
    node,
    changes,
    packages,
    saved,
    calls,
    /** The next `npm ci` waits; `await reached` until it does. */
    hold() {
      gate = { ...deferred(), reached: deferred() };
      const held = gate;
      return { reached: held.reached.promise, release: held.open };
    },
  };
}

export const preview = (s, version = "1.0.0", extra = {}) =>
  s.packages.preview({ ...ref(version), ...extra });

/** A packaged server bound to Claude Code, created from a fresh preview. */
export async function createPackaged(s, extra = {}) {
  const confirmed = await preview(s);
  const server = await s.packages.createServer(
    {
      name: "pkg",
      transport: "stdio",
      args: ["--owner"],
      env: { TOKEN: "t" },
      source: ref(),
      ...extra,
    },
    { previewId: confirmed.previewId, clis: ["claude"] },
  );
  return { preview: confirmed, server };
}
