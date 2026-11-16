import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHermesRuntime,
  runtimeInstallsOf,
} from "../../server/application/hermes-wiring.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";

// The owner's Hermes switch announces every change of its state (hermes-wiring.js),
// which the live topic `runtimes` follows.

// A data directory with Hermes switched on and an installation selected.
function installed(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-list-hermes-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "assistants", "hermes");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "assistants", "settings.json"),
    JSON.stringify({ hermes: { enabled: true } }),
  );
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: "0.0.1", directory: path.join(root, "0.0.1") }),
  );
  return dataDir;
}

test("a Hermes update announces its start and its end", async (t) => {
  const dataDir = installed(t);
  let release;
  const staged = new Promise((resolve) => (release = resolve));
  const hermes = createHermesRuntime({
    config: { dataDir },
    updates: () => ({
      stage: () => staged,
      status: () => ({ candidateReady: false, blockerItems: [] }),
    }),
  });
  const seen = [];
  hermes.onChange = () => seen.push(hermes.state().updating);
  const state = await hermes.update();
  assert.equal(state.updating, true);
  assert.deepEqual(seen, [true]);
  release();
  await hermes.updating();
  assert.deepEqual(seen, [true, false]);
});

test("a refused Hermes update announces the work that blocks it", async (t) => {
  const dataDir = installed(t);
  const items = [{ code: "ASSISTANT_WORK" }];
  const hermes = createHermesRuntime({
    config: { dataDir },
    updates: () => ({
      stage: async () => {},
      status: () => ({ candidateReady: true, blockerItems: items }),
      activate: () =>
        Promise.reject(Object.assign(Error("blocked"), { code: "UPDATE_BLOCKED" })),
    }),
  });
  const seen = [];
  hermes.onChange = () => seen.push(hermes.state());
  await hermes.update();
  await hermes.updating();
  assert.equal(seen.at(-1).updating, false);
  assert.equal(seen.at(-1).error, "UPDATE_BLOCKED");
  assert.deepEqual(seen.at(-1).blockerItems, items);
});

test("the install sources name the optional runtime by its descriptor and read lazily", () => {
  const services = {};
  const installs = runtimeInstallsOf(services);
  assert.deepEqual(Object.keys(installs), [hermesDescriptor.id]);
  // Hermes not wired: no state.
  assert.equal(installs[hermesDescriptor.id](), undefined);
  services.hermesRuntime = { state: () => ({ enabled: true, installed: false }) };
  assert.deepEqual(installs[hermesDescriptor.id](), { enabled: true, installed: false });
});
