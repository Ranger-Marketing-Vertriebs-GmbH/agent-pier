import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizePreviewConfig,
  readPreviewConfig,
  tailscaleHttpsPort,
  writePreviewConfig,
} from "../../server/features/previews/preview-config.js";
import { previewError } from "../../server/features/previews/preview-errors.js";

const constraints = {
  hostPort: 4380,
  pipelineRange: { start: 20100, end: 20999 },
  tailscaleHttpsPort: 8443,
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "preview-config-"));

test("missing previews config means disabled 47100-47109", () => {
  for (const raw of [undefined, null])
    assert.deepEqual(normalizePreviewConfig(raw, constraints), {
      enabled: false,
      portRangeStart: 47100,
      portRangeEnd: 47109,
    });
});

test("range rules: >=1024, <=65535, at most 50 ports, end >= start", () => {
  for (const [s, e] of [
    [1023, 1030],
    [65530, 65536],
    [47100, 47150],
    [47110, 47100],
  ])
    assert.throws(
      () =>
        normalizePreviewConfig(
          { enabled: true, portRangeStart: s, portRangeEnd: e },
          constraints,
        ),
      { code: "PREVIEW_RANGE_INVALID", status: 400 },
    );
  assert.equal(
    normalizePreviewConfig(
      { enabled: true, portRangeStart: 47100, portRangeEnd: 47149 },
      constraints,
    ).portRangeEnd,
    47149,
  );
});

test("unknown keys and wrong types are refused", () => {
  assert.throws(() => normalizePreviewConfig({ enabled: true, extra: 1 }, constraints), {
    code: "PREVIEW_RANGE_INVALID",
  });
  assert.throws(() => normalizePreviewConfig({ enabled: "yes" }, constraints), {
    code: "PREVIEW_RANGE_INVALID",
  });
});

test("range may not contain AgentPier's port, the pipeline range or the Tailscale HTTPS port", () => {
  for (const [s, e] of [
    [4380, 4389],
    [20990, 21000],
    [8440, 8449],
  ])
    assert.throws(
      () =>
        normalizePreviewConfig(
          { enabled: true, portRangeStart: s, portRangeEnd: e },
          constraints,
        ),
      { code: "PREVIEW_RANGE_INVALID" },
    );
});

test("writePreviewConfig keeps every other config.json key", () => {
  const dir = tmp();
  const other = { port: 4390, remoteUrl: "https://x.ts.net:8443", ownerLogin: "me" };
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ ...other, network: { a: 1 } }),
  );
  writePreviewConfig(dir, { enabled: true, portRangeStart: 47100, portRangeEnd: 47109 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  for (const key of Object.keys(other)) assert.equal(saved[key], other[key]);
  assert.deepEqual(saved.network, { a: 1 });
  assert.equal(saved.previews.enabled, true);
  assert.equal(readPreviewConfig(dir, constraints).enabled, true);
});

test("a corrupt stored range reads as the default range, keeping enabled", () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ previews: { enabled: true, portRangeStart: 5, portRangeEnd: 2 } }),
  );
  assert.deepEqual(readPreviewConfig(dir, constraints), {
    enabled: true,
    portRangeStart: 47100,
    portRangeEnd: 47109,
  });
  assert.equal(readPreviewConfig(tmp(), constraints).enabled, false);
});

test("tailscaleHttpsPort reads the port of the remote URL", () => {
  assert.equal(tailscaleHttpsPort("https://x.ts.net:8443"), 8443);
  assert.equal(tailscaleHttpsPort("https://x.ts.net"), 443);
  assert.equal(tailscaleHttpsPort(null), null);
  assert.equal(tailscaleHttpsPort(undefined), null);
});

test("previewError carries code, status and a German message", () => {
  const error = previewError("PREVIEW_RANGE_FULL", 409);
  assert.equal(error.code, "PREVIEW_RANGE_FULL");
  assert.equal(error.status, 409);
  assert.notEqual(error.message, "PREVIEW_RANGE_FULL");
});
