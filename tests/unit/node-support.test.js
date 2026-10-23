import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { isPatchedNode, nodeCheckStatus } from "../../server/lib/node-support.js";
import { NODE_RUNTIME_VERSION } from "../../server/features/operations/release-runtime.js";

const PATCHED = [
  "22.23.4",
  "22.24.0",
  "24.22.1",
  "24.23.0",
  "26.12.1",
  "26.13.0",
  "27.0.0",
];
const VULNERABLE = [
  "22.13.0",
  "22.22.2",
  "22.23.3",
  "23.11.0",
  "24.22.0",
  "24.16.0",
  "26.7.0",
  "26.12.0",
  "20.19.0",
];

test("isPatchedNode accepts only the security-fixed releases", () => {
  for (const version of PATCHED) assert.equal(isPatchedNode(version), true, version);
  for (const version of VULNERABLE) assert.equal(isPatchedNode(version), false, version);
});

test("package.json engines, the bundled runtime and the installer agree", () => {
  const { engines } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(engines.node, "^22.23.4 || ^24.22.1 || >=26.12.1");
  assert.equal(isPatchedNode(NODE_RUNTIME_VERSION), true);
  const installer = fs.readFileSync("scripts/install.sh", "utf8");
  assert.match(installer, new RegExp(`^VERSION=${NODE_RUNTIME_VERSION}$`, "m"));
  const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
  for (const match of release.matchAll(/node-version: (\S+)/g))
    assert.equal(match[1], NODE_RUNTIME_VERSION);
});

test("the installer's host Node check matches isPatchedNode", () => {
  const script = fs
    .readFileSync("scripts/install.sh", "utf8")
    .match(/node -e '([^']*process\.versions\.node[^']*)'/)?.[1];
  assert.ok(script, "host check not found");
  for (const version of [...PATCHED, ...VULNERABLE]) {
    let accepted = true;
    try {
      execFileSync(process.execPath, [
        "-e",
        script.replace(/process\.versions\.node/g, JSON.stringify(version)),
      ]);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, isPatchedNode(version), version);
  }
});

test("the doctor node check warns on unpatched, passes patched and fails below 22.13", () => {
  for (const version of ["22.22.2", "22.13.0", "24.22.0", "23.11.0"])
    assert.equal(nodeCheckStatus(version), "warn", version);
  for (const version of ["22.23.4", "24.22.1", "26.12.1"])
    assert.equal(nodeCheckStatus(version), "ok", version);
  for (const version of ["20.19.0", "22.12.9", "18.0.0"])
    assert.equal(nodeCheckStatus(version), "fail", version);
});
