import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import {
  bundlePatchId,
  runtimeBundlePatches,
  verifyBundlePatches,
} from "../../server/features/assistants/runtimes/openclaw/runtime-bundle-patches.js";
import { assertCodexClientVersionFloor } from "../helpers/codex-client-version-floor.js";
import { assertNoRestartResume } from "../helpers/restart-resume-guard.js";
import { assertSupersededPublicationRetried } from "../helpers/superseded-publication-guard.js";

// The pinned runtime as the installer provisioned it carries AgentPier's patches of
// its version (runtime-bundle-patches.js): the patched text, the receipt that records
// them, and OpenClaw's content inventory naming the patched file's digest and size.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "the provisioned pinned runtime carries the lease release, Codex catalog, restart resume and superseded publication patches",
  { skip: !installed },
  () => {
    const app = path.join(installed, "app", "node_modules", "openclaw");
    const version = JSON.parse(fs.readFileSync(path.join(app, "package.json"))).version;
    assert.equal(version, runtimeManifest.version);
    const patches = runtimeBundlePatches[version] || [];
    assert.ok(patches.length, "the pinned version has patches");
    verifyBundlePatches(app, version);
    const receipt = JSON.parse(fs.readFileSync(path.join(installed, "receipt.json")));
    assert.equal(receipt.bundlePatch, bundlePatchId(version));
    assert.match(path.basename(installed), new RegExp(`-patch${receipt.bundlePatch}$`));
    const inventory = JSON.parse(
      fs.readFileSync(path.join(app, "dist", "postinstall-content-inventory.json")),
    );
    for (const patch of patches) {
      const bytes = fs.readFileSync(path.join(app, ...patch.file.split("/")));
      assert.ok(bytes.toString("utf8").includes(patch.after), patch.id);
      const entry = inventory.find((item) => item.path === patch.file);
      assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(entry.size, bytes.length);
    }
  },
);

// Independent of any patch: the installed package asks the ChatGPT model catalog as a
// Codex client of at least 0.169.0, so a pin bump cannot drop the patch unnoticed.
test(
  "the provisioned pinned runtime asks the Codex catalog as a recent client",
  { skip: !installed },
  () => {
    const app = path.join(installed, "app", "node_modules", "openclaw");
    const found = assertCodexClientVersionFloor(app);
    assert.ok(found.length >= 2, JSON.stringify(found));
  },
);

// Independent of any patch: after a Gateway restart the installed package settles an
// interrupted main-session turn and never asks the model to resume it, so a pin bump
// cannot drop the patch unnoticed. The runtime contract's crash step checks the same
// against a running Gateway (assistant-runtime-contract.test.js).
test(
  "the provisioned pinned runtime never resumes an interrupted turn on its own",
  { skip: !installed },
  () => {
    const app = path.join(installed, "app", "node_modules", "openclaw");
    const found = assertNoRestartResume(app);
    assert.deepEqual(
      found.filter((site) => site.defines).map((site) => site.calls),
      [0],
    );
  },
);

// Independent of any patch: the agent database startup after a Doctor migration
// publishes an agent again when a concurrent model runtime refresh (models.authRefresh)
// superseded its publication, instead of leaving it degraded until the next restart,
// so a pin bump cannot drop the patch unnoticed.
test(
  "the provisioned pinned runtime retries a superseded startup publication",
  { skip: !installed },
  () => {
    const app = path.join(installed, "app", "node_modules", "openclaw");
    const found = assertSupersededPublicationRetried(app);
    assert.ok(found.length >= 1, JSON.stringify(found));
  },
);
