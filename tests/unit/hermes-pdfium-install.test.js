import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import {
  ensureHermesRuntime,
  stageHermesRuntime,
} from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import {
  hermesManifest,
  validHermesManifest,
} from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { hasPdfium } from "../../server/features/assistants/runtimes/hermes/hermes-pdfium.js";
import {
  hermesStagingDue,
  writeHermesEnabled,
} from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";

// AgentPier's pdf tool of a Hermes agent reads pages with pypdfium2, which Hermes's
// lock does not name: the installation provisions the pinned wheel of its platform,
// and an installation from before gets it at the next staging.

test("the manifest pins one pypdfium2 wheel per platform with its SHA-256", () => {
  assert.equal(hermesManifest.pdfium.version, "5.14.0");
  assert.deepEqual(Object.keys(hermesManifest.pdfium.wheels).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  for (const [target, wheel] of Object.entries(hermesManifest.pdfium.wheels)) {
    assert.match(wheel.url, /^https:\/\/files\.pythonhosted\.org\/packages\//, target);
    assert.match(wheel.sha256, /^[0-9a-f]{64}$/, target);
  }
  const { pdfium: _pin, ...without } = hermesManifest;
  assert.throws(() => validHermesManifest(without), /manifest/);
  const swapped = {
    ...hermesManifest.pdfium,
    wheels: {
      ...hermesManifest.pdfium.wheels,
      "linux-x64": hermesManifest.pdfium.wheels["linux-arm64"],
    },
  };
  assert.throws(
    () => validHermesManifest({ ...hermesManifest, pdfium: swapped }),
    /manifest/,
  );
  const elsewhere = {
    ...hermesManifest.pdfium,
    wheels: {
      ...hermesManifest.pdfium.wheels,
      "darwin-arm64": {
        ...hermesManifest.pdfium.wheels["darwin-arm64"],
        url: "https://example.test/pypdfium2-5.14.0-py3-none-macosx_13_0_arm64.whl",
      },
    },
  };
  assert.throws(
    () => validHermesManifest({ ...hermesManifest, pdfium: elsewhere }),
    /manifest/,
  );
});

test("an installation adds the platform's pypdfium2 wheel with uv, offline and alone", async (t) => {
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  const wheel = f.manifest.pdfium.wheels["linux-x64"];
  assert.ok(hasPdfium(record.directory, f.manifest, "linux-x64"));
  const { python, uv } = hermesExecutables(record.directory);
  const install = f.calls.find((call) => call.file === uv && call.args[0] === "pip");
  assert.deepEqual(install.args.slice(0, -1), [
    "pip",
    "install",
    "--python",
    python,
    "--no-deps",
    "--no-index",
    "--no-cache",
  ]);
  assert.equal(
    path.basename(install.args.at(-1)),
    path.basename(new URL(wheel.url).pathname),
  );
  // uv stays inside AgentPier's folder, as for the installation itself.
  assert.equal(install.env.UV_NO_CONFIG, "1");
  assert.equal(install.env.SECRET, undefined);
  assert.ok(
    f.calls.some(
      (call) => call.file === python && call.args.join(" ") === "-I -c import pypdfium2",
    ),
  );
});

test("an installation from before the pdf tool gets PDFium at the next staging", async (t) => {
  const f = hermesInstallFixture(t);
  writeHermesEnabled(f.dataDir, true);
  const record = await ensureHermesRuntime(f.options);
  fs.rmSync(path.join(hermesExecutables(record.directory).tools, "pdfium.json"));
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), true);
  const before = f.calls.length;
  assert.deepEqual(await stageHermesRuntime(f.options), record);
  assert.deepEqual(
    f.calls.slice(before).filter((call) => call.download),
    [{ download: f.manifest.pdfium.wheels["linux-x64"].url }],
  );
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), false);
});

test("a changed wheel installs nothing", async (t) => {
  const f = hermesInstallFixture(t);
  f.tamper(f.manifest.pdfium.wheels["linux-x64"].url, Buffer.from("changed"));
  await assert.rejects(ensureHermesRuntime(f.options), {
    code: "HERMES_CHECKSUM_MISMATCH",
  });
  assert.deepEqual(
    fs.readdirSync(path.join(f.dataDir, "assistants/hermes/runtimes")),
    [],
  );
});
