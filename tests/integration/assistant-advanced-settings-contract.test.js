import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { AdvancedConfig } from "../../server/features/assistants/advanced-config.js";
import {
  OverrideStore,
  overridesFor,
} from "../../server/features/assistants/openclaw-config/overrides.js";
import {
  advancedSettings,
  advancedSettingsRuntime,
} from "../../server/features/assistants/openclaw-config/advanced-settings.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";

// The bundled runtime; the same variable as the native interfaces contract.
const installed = process.env.AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const signatureKeys = [
  "type",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "anyOf",
];

function schemaNode(root, target) {
  let node = root;
  for (const key of target.split(".")) node = node?.properties?.[key];
  return node;
}

const signature = (node) =>
  Object.fromEntries(signatureKeys.filter((k) => k in node).map((k) => [k, node[k]]));

function valueAt(config, target) {
  return target.split(".").reduce((node, key) => node?.[key], config);
}

async function gateway(t) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "advanced-settings-"));
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const runtime = new RuntimeSupervisor({
    dataDir,
    configOverrides: (version) => overridesFor(overrides, version),
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
  return { runtime, overrides };
}

test("the allow list matches the bundled OpenClaw schema", options, async (t) => {
  const { runtime } = await gateway(t);
  const { client } = runtime;
  assert.equal(advancedSettingsRuntime, runtimeManifest.version);
  const schema = await client.call("config.schema", {});
  assert.equal(schema.version, advancedSettingsRuntime);
  t.diagnostic(
    `config.schema bytes=${JSON.stringify(schema).length} hints=${Object.keys(schema.uiHints).length}`,
  );
  // OpenClaw writes none of the allowed paths itself, so a start may remove them all.
  const { config } = await client.call("config.get", {});
  for (const setting of advancedSettings) {
    assert.equal(valueAt(config, setting.path), undefined, setting.path);
    const node = schemaNode(schema.schema, setting.path);
    assert.ok(node, `${setting.path} is gone from config.schema`);
    assert.deepEqual(signature(node), setting.schema, setting.path);
    assert.notEqual(schema.uiHints[setting.path]?.sensitive, true, setting.path);
    const lookup = await client.call("config.schema.lookup", { path: setting.path });
    assert.equal(lookup.reloadKind, setting.reloadKind, setting.path);
  }
  // The facts our copy states, where upstream documents them: the image default,
  // and that an unset retention runs no general sweep (any value deletes received
  // media too, which is why the floor is 48 hours).
  assert.match(
    schema.uiHints["agents.defaults.imageMaxDimensionPx"].help,
    /\(default: 1200\)/,
  );
  assert.match(
    schema.uiHints["attachments.ttlHours"].help,
    /Leave unset to disable that sweep/,
  );
  // The Gateway validates a patch against the same schema.
  const current = await client.call("config.get", {});
  await assert.rejects(
    client.call("config.patch", {
      baseHash: current.hash,
      raw: JSON.stringify({ attachments: { ttlHours: 500 } }),
    }),
    { code: "INVALID_REQUEST" },
  );
});

test(
  "advanced settings apply live and a reset survives a restart",
  options,
  async (t) => {
    const { runtime, overrides } = await gateway(t);
    const advanced = new AdvancedConfig({
      assistants: { runtime, admit: (operation) => operation() },
      overrides,
      synchronization: {},
    });
    const listed = await advanced.get();
    assert.equal(listed.gateway.running, true);
    assert.ok(listed.settings.every((s) => s.available));

    const read = async (target) =>
      valueAt((await runtime.client.call("config.get", {})).config, target);
    await advanced.save("agents.defaults.timeoutSeconds", 900);
    await advanced.save("agents.defaults.userTimezone", "Europe/Berlin");
    await advanced.save("attachments.ttlHours", 72);
    assert.equal(await read("agents.defaults.timeoutSeconds"), 900);
    assert.equal(await read("attachments.ttlHours"), 72);
    const saved = await advanced.get();
    assert.equal(
      saved.settings.find((s) => s.id === "userTimezone").current,
      "Europe/Berlin",
    );

    // A null merge removes the path from the running Gateway.
    await advanced.save("attachments.ttlHours", null);
    assert.equal(await read("attachments.ttlHours"), undefined);
    t.diagnostic(`attachments after reset=${JSON.stringify(await read("attachments"))}`);

    // The stored overrides are compiled into the next start; a reset one is not.
    await runtime.stop();
    await runtime.start();
    assert.equal(await read("agents.defaults.timeoutSeconds"), 900);
    assert.equal(await read("agents.defaults.userTimezone"), "Europe/Berlin");
    assert.equal(await read("attachments.ttlHours"), undefined);
    await advanced.save("agents.defaults.timeoutSeconds", null);
    overrides.remove("agents.defaults.userTimezone");
    await runtime.stop();
    await runtime.start();
    assert.equal(await read("agents.defaults.timeoutSeconds"), undefined);
    assert.equal(await read("agents.defaults.userTimezone"), undefined);
  },
);
