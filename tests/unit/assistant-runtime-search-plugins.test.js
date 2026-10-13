import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  selectedAssistantRuntime,
  stageAssistantRuntime,
} from "../../server/features/assistants/runtime-install.js";
import { readRuntimeLock } from "../../server/features/assistants/runtime-lock.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import {
  addSearchPlugins,
  assistantInstallFixture,
} from "../helpers/assistant-install-fixture.js";

const pluginIds = ["duckduckgo", "perplexity", "brave"];

test("shipped lock pins the three search plugins with registry integrity", () => {
  const { packageBytes, lockBytes } = readRuntimeLock(runtimeManifest);
  const { dependencies } = JSON.parse(packageBytes);
  const { packages } = JSON.parse(lockBytes);
  assert.deepEqual(
    Object.keys(runtimeManifest.searchPlugins).sort(),
    [...pluginIds].sort(),
  );
  for (const id of pluginIds) {
    const pin = runtimeManifest.searchPlugins[id];
    assert.equal(pin.id, id);
    assert.equal(pin.package, `@openclaw/${id}-plugin`);
    assert.equal(pin.version, "2026.9.9");
    assert.equal(dependencies[pin.package], "2026.9.9");
    const entry = packages[`node_modules/${pin.package}`];
    assert.equal(entry.version, "2026.9.9");
    assert.equal(entry.integrity, `sha512-${pin.integrity}`);
    assert.equal(
      entry.resolved,
      `https://registry.npmjs.org/@openclaw/${id}-plugin/-/${id}-plugin-2026.9.9.tgz`,
    );
    // No plugin pulls in further packages: it only imports openclaw's plugin SDK.
    assert.equal(entry.dependencies, undefined);
  }
  assert.equal(dependencies.openclaw, "file:openclaw.tgz");
});

test("fresh install places the plugins and exposes their directories", async (t) => {
  const f = assistantInstallFixture(t);
  const manifest = addSearchPlugins(f);
  const execute = f.options.execute;
  const installed = await stageAssistantRuntime({
    ...f.options,
    manifest,
    execute: async (command, args, options) => {
      if (args.includes("ci")) {
        assert.ok(args.includes("--ignore-scripts"));
        const pkg = JSON.parse(fs.readFileSync(path.join(options.cwd, "package.json")));
        for (const id of pluginIds)
          assert.equal(pkg.dependencies[`@openclaw/${id}-plugin`], "2026.9.9");
      }
      return execute(command, args, options);
    },
  });
  const app = path.resolve(installed.entryPath, "../../..");
  assert.deepEqual(installed.searchPlugins, {
    duckduckgo: {
      id: "duckduckgo",
      directory: path.join(app, "node_modules/@openclaw/duckduckgo-plugin"),
    },
    perplexity: {
      id: "perplexity",
      directory: path.join(app, "node_modules/@openclaw/perplexity-plugin"),
    },
    brave: {
      id: "brave",
      directory: path.join(app, "node_modules/@openclaw/brave-plugin"),
    },
  });
  const receipt = JSON.parse(fs.readFileSync(path.resolve(app, "../receipt.json")));
  assert.deepEqual(receipt.searchPlugins, manifest.searchPlugins);
  const cached = await stageAssistantRuntime({
    ...f.options,
    manifest,
    download: () => assert.fail("unexpected download"),
    execute: () => assert.fail("unexpected execution"),
  });
  assert.deepEqual(cached.searchPlugins, installed.searchPlugins);
  fs.writeFileSync(
    path.join(f.dataDir, "assistants/runtime.json"),
    JSON.stringify(installed),
  );
  const selected = await selectedAssistantRuntime({ ...f.options, manifest });
  assert.deepEqual(selected.searchPlugins, installed.searchPlugins);
});

test("updating an existing installation stages the plugins beside it", async (t) => {
  const f = assistantInstallFixture(t);
  const previous = await stageAssistantRuntime(f.options);
  assert.deepEqual(previous.searchPlugins, {});
  const selection = path.join(f.dataDir, "assistants/runtime.json");
  fs.writeFileSync(selection, JSON.stringify(previous));
  const manifest = addSearchPlugins(f);
  const candidate = await stageAssistantRuntime({ ...f.options, manifest });
  assert.notEqual(candidate.nodePath, previous.nodePath);
  assert.deepEqual(Object.keys(candidate.searchPlugins), pluginIds);
  for (const plugin of Object.values(candidate.searchPlugins))
    assert.ok(fs.existsSync(path.join(plugin.directory, "openclaw.plugin.json")));
  // The update records a candidate; the running selection is unchanged and, being
  // installed before plugins were bundled, reports none.
  assert.deepEqual(JSON.parse(fs.readFileSync(selection)), previous);
  const candidateFile = path.join(f.dataDir, "assistants/candidate.json");
  assert.equal(JSON.parse(fs.readFileSync(candidateFile)).nodePath, candidate.nodePath);
  assert.deepEqual((await selectedAssistantRuntime(f.options)).searchPlugins, {});
  fs.writeFileSync(selection, JSON.stringify(candidate));
  assert.deepEqual(
    (await selectedAssistantRuntime(f.options)).searchPlugins,
    candidate.searchPlugins,
  );
});

test("lock without the pinned plugin or with other integrity fails before download", async (t) => {
  for (const change of [
    (pkg, lock) => {
      delete pkg.dependencies["@openclaw/brave-plugin"];
      delete lock.packages[""].dependencies["@openclaw/brave-plugin"];
      delete lock.packages["node_modules/@openclaw/brave-plugin"];
    },
    (_pkg, lock) => {
      lock.packages["node_modules/@openclaw/brave-plugin"].integrity =
        "sha512-" + Buffer.alloc(64).toString("base64");
    },
    (pkg, lock) => {
      pkg.dependencies["@openclaw/brave-plugin"] = "^2026.9.9";
      lock.packages[""].dependencies = pkg.dependencies;
    },
  ]) {
    const f = assistantInstallFixture(t);
    const manifest = addSearchPlugins(f);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(f.lockDirectory, name)));
    const pkg = read("package.json"),
      lock = read("package-lock.json");
    change(pkg, lock);
    fs.writeFileSync(path.join(f.lockDirectory, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(f.lockDirectory, "package-lock.json"),
      JSON.stringify(lock),
    );
    await assert.rejects(
      stageAssistantRuntime({
        ...f.options,
        manifest: { ...manifest, dependencyLockSha256: f.digest() },
        download: () => assert.fail("invalid plugin lock must fail before download"),
      }),
      /lock metadata|search plugin/,
    );
  }
});

test("an installed plugin that does not match its pin fails the installation", async (t) => {
  const f = assistantInstallFixture(t);
  const manifest = addSearchPlugins(f);
  const execute = f.options.execute;
  await assert.rejects(
    stageAssistantRuntime({
      ...f.options,
      manifest,
      execute: async (command, args, options) => {
        const output = await execute(command, args, options);
        if (args.includes("ci"))
          fs.writeFileSync(
            path.join(
              options.cwd,
              "node_modules/@openclaw/brave-plugin/openclaw.plugin.json",
            ),
            JSON.stringify({ id: "other" }),
          );
        return output;
      },
    }),
    /search plugin installation mismatch/,
  );
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "assistants/runtimes")), []);
});

test("lock refresh keeps a seeded graph and adds the pinned plugins", async (t) => {
  const { refreshAssistantRuntimeLock } =
    await import("../../scripts/refresh-assistant-runtime-lock.mjs");
  const f = assistantInstallFixture(t);
  const seed = path.join(f.root, "seed");
  fs.cpSync(f.lockDirectory, seed, { recursive: true });
  const manifest = addSearchPlugins(f);
  const output = path.join(f.root, "output");
  const result = await refreshAssistantRuntimeLock({
    runtimeDirectory: path.join(f.root, "runtime"),
    outputDirectory: output,
    manifest,
    seedDirectory: seed,
    download: f.options.download,
    execute: async (_command, args, options) => {
      if (args.length === 1) return { stdout: "v26.7.0\n" };
      if (args.length === 2) return { stdout: "11.19.0\n" };
      assert.ok(args.includes("--package-lock-only"));
      assert.ok(args.includes("--ignore-scripts"));
      // npm starts from the seeded graph; this stub resolves the plugins.
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(options.cwd, "package-lock.json"))),
        JSON.parse(fs.readFileSync(path.join(seed, "package-lock.json"))),
      );
      const pkg = JSON.parse(fs.readFileSync(path.join(options.cwd, "package.json")));
      assert.deepEqual(
        pkg.dependencies,
        JSON.parse(fs.readFileSync(path.join(f.lockDirectory, "package.json")))
          .dependencies,
      );
      fs.copyFileSync(
        path.join(f.lockDirectory, "package-lock.json"),
        path.join(options.cwd, "package-lock.json"),
      );
      return { stdout: "" };
    },
  });
  // The output passes the full lock validation, including the plugin pins.
  const { packageBytes } = readRuntimeLock(
    { ...manifest, dependencyLockSha256: result.dependencyLockSha256 },
    output,
  );
  assert.deepEqual(Object.keys(JSON.parse(packageBytes).dependencies), [
    "@openclaw/brave-plugin",
    "@openclaw/duckduckgo-plugin",
    "@openclaw/perplexity-plugin",
    "openclaw",
  ]);
});
