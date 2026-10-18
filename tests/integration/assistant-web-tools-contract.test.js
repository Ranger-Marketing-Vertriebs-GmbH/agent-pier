import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";

const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME",
  timeout: 300000,
};

async function gateway(t) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-web-search-"));
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({
      version: runtimeManifest.version,
      nodePath: path.join(installed, "node/bin/node"),
      entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    }),
  });
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await runtime.start();
  return runtime.client;
}

async function answer(promise) {
  try {
    return { result: await promise };
  } catch (error) {
    return { code: error.code, answered: error.answered === true };
  }
}

test(
  "each bundled search plugin makes its web search provider available",
  options,
  async (t) => {
    const client = await gateway(t);
    for (const [key, pin] of Object.entries(runtimeManifest.searchPlugins)) {
      // The installed runtime holds the pinned plugin package in its locked graph.
      const directory = path.join(installed, "app/node_modules", pin.package);
      const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name)));
      assert.equal(read("package.json").version, pin.version, key);
      assert.equal(read("openclaw.plugin.json").id, pin.id, key);

      // Not loaded, the provider is unknown to the Gateway.
      const missing = await answer(
        patchConfig(client, () => ({
          patch: { tools: { web: { search: { provider: pin.id } } } },
        })),
      );
      t.diagnostic(`${key} without plugin=${JSON.stringify(missing)}`);
      assert.deepEqual(missing, { code: "INVALID_REQUEST", answered: true }, key);

      // Loaded from its directory and allowed, the provider is accepted. Keyed
      // providers take their key in the plugin's configuration, which stays redacted.
      const keyed = key !== "duckduckgo";
      await patchConfig(client, () => ({
        patch: {
          plugins: {
            allow: [pin.id],
            load: { paths: [directory] },
            ...(keyed && {
              entries: { [pin.id]: { config: { webSearch: { apiKey: "fixture-key" } } } },
            }),
          },
          tools: { web: { search: { provider: pin.id } } },
        },
        replacePaths: ["plugins.allow", "plugins.load.paths"],
      }));
      const { config } = await client.call("config.get", {});
      assert.equal(config.tools.web.search.provider, pin.id, key);
      assert.deepEqual(config.plugins.allow, [pin.id], key);
      assert.deepEqual(config.plugins.load.paths, [directory], key);
      if (keyed)
        assert.notEqual(
          config.plugins.entries[pin.id].config.webSearch.apiKey,
          "fixture-key",
          `${key} key must be redacted`,
        );
      // The Gateway runs the pinned package from the configured path.
      const listed = await client.call("plugins.list", {});
      const plugin = (listed.plugins ?? listed).find((p) => p.id === pin.id);
      t.diagnostic(`${key} plugins.list=${JSON.stringify(plugin)}`);
      assert.equal(plugin?.packageName, pin.package, key);
      assert.equal(plugin.version, pin.version, key);
      assert.equal(plugin.origin, "config", key);
      assert.equal(plugin.runtime?.state, "active", key);

      // Unloading it again leaves no provider behind for the next plugin.
      await patchConfig(client, () => ({
        patch: {
          plugins: { allow: [], load: { paths: [] } },
          tools: { web: { search: { provider: null } } },
        },
        replacePaths: ["plugins.allow", "plugins.load.paths"],
      }));
    }
  },
);
