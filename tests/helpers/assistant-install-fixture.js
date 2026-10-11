import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export function assistantInstallFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-locked-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const source = path.join(root, "source/node-test");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(path.join(source, "bin/node"), "fixture node");
  fs.mkdirSync(path.join(source, "lib/node_modules/npm/bin"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "lib/node_modules/npm/package.json"),
    JSON.stringify({ version: "11.19.0" }),
  );
  fs.writeFileSync(
    path.join(source, "lib/node_modules/npm/bin/npm-cli.js"),
    "fixture npm",
  );
  const nodeBytes = execFileSync("tar", [
    "-czf",
    "-",
    "-C",
    path.dirname(source),
    "node-test",
  ]);
  const packageBytes = Buffer.from("fixture package");
  const integrity = createHash("sha512").update(packageBytes).digest("base64");
  const lockDirectory = path.join(root, "lock");
  fs.mkdirSync(lockDirectory);
  const pkg = {
    name: "agentpier-managed-assistants",
    version: "1.0.0",
    private: true,
    dependencies: { openclaw: "file:openclaw.tgz" },
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": pkg,
      "node_modules/openclaw": {
        version: "2026.9.8",
        resolved: "file:openclaw.tgz",
        integrity: `sha512-${integrity}`,
      },
    },
  };
  for (const [name, value] of [
    ["package.json", pkg],
    ["package-lock.json", lock],
  ])
    fs.writeFileSync(
      path.join(lockDirectory, name),
      JSON.stringify(value, null, 2) + "\n",
    );
  const digest = () =>
    createHash("sha256")
      .update(fs.readFileSync(path.join(lockDirectory, "package.json")))
      .update("\0")
      .update(fs.readFileSync(path.join(lockDirectory, "package-lock.json")))
      .digest("hex");
  const manifest = {
    version: "2026.9.8",
    nodeVersion: "26.7.0",
    npmVersion: "11.19.0",
    packageUrl: "https://example.invalid/openclaw.tgz",
    packageIntegrity: integrity,
    dependencyLockSha256: digest(),
    nodeChecksums: {
      "darwin-arm64": createHash("sha256").update(nodeBytes).digest("hex"),
    },
  };
  const commands = [];
  const options = {
    dataDir,
    platform: "darwin",
    arch: "arm64",
    manifest,
    lockDirectory,
    download: async (url) => (url === manifest.packageUrl ? packageBytes : nodeBytes),
    execute: async (command, args, opts) => {
      commands.push({ command, args, opts });
      if (command === "tar") return execFileSync(command, args);
      if (args.includes("ci") || args.includes("install")) {
        const dir = path.join(opts.cwd, "node_modules/openclaw");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ version: manifest.version }),
        );
        fs.writeFileSync(path.join(dir, "openclaw.mjs"), "fixture entry");
        const { dependencies } = JSON.parse(
          fs.readFileSync(path.join(opts.cwd, "package.json")),
        );
        for (const [name, version] of Object.entries(dependencies)) {
          if (name === "openclaw") continue;
          const plugin = path.join(opts.cwd, "node_modules", name);
          fs.mkdirSync(plugin, { recursive: true });
          fs.writeFileSync(
            path.join(plugin, "package.json"),
            JSON.stringify({ name, version }),
          );
          fs.writeFileSync(
            path.join(plugin, "openclaw.plugin.json"),
            JSON.stringify({ id: /^@openclaw\/(.+)-plugin$/.exec(name)[1] }),
          );
        }
      }
      return { stdout: manifest.version };
    },
  };
  return { root, dataDir, lockDirectory, manifest, digest, options, commands };
}

/**
 * Adds the three pinned search plugins (synthetic registry integrity) to a
 * fixture's lock and returns the manifest that pins them.
 */
export function addSearchPlugins(f) {
  const searchPlugins = Object.fromEntries(
    ["duckduckgo", "perplexity", "brave"].map((id) => [
      id,
      {
        id,
        package: `@openclaw/${id}-plugin`,
        version: "2026.9.8",
        integrity: createHash("sha512").update(id).digest("base64"),
      },
    ]),
  );
  const read = (name) => JSON.parse(fs.readFileSync(path.join(f.lockDirectory, name)));
  const pkg = read("package.json"),
    lock = read("package-lock.json");
  for (const pin of Object.values(searchPlugins)) {
    pkg.dependencies[pin.package] = pin.version;
    lock.packages[`node_modules/${pin.package}`] = {
      version: pin.version,
      resolved: `https://registry.npmjs.org/${pin.package}/-/${pin.id}-plugin-${pin.version}.tgz`,
      integrity: `sha512-${pin.integrity}`,
      peerDependencies: { openclaw: ">=2026.9.8" },
    };
  }
  lock.packages[""].dependencies = pkg.dependencies;
  for (const [name, value] of [
    ["package.json", pkg],
    ["package-lock.json", lock],
  ])
    fs.writeFileSync(
      path.join(f.lockDirectory, name),
      JSON.stringify(value, null, 2) + "\n",
    );
  return { ...f.manifest, searchPlugins, dependencyLockSha256: f.digest() };
}
