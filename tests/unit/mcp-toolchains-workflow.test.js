import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/mcp-toolchains.yml"), "utf8"),
);
const steps = workflow.jobs.native.steps;
const matches = (pattern, file) =>
  new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`).test(file);

test("the native toolchain job keeps no Git credentials", () => {
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with?.["persist-credentials"], false);
});

test("the native check asserts the runner is the matrix target", () => {
  const verify = steps.find((step) => step.run?.includes("verify-mcp-toolchains.mjs"));
  assert.equal(verify.env?.TARGET, "${{ matrix.target }}");
  assert.match(verify.run, /verify-mcp-toolchains\.mjs "\$TARGET"/);
});

test("every module the native check runs triggers the workflow", () => {
  const modules = [
    "server/features/mcp-packages/toolchains.js",
    "server/features/mcp-packages/toolchain-manifest.js",
    "server/features/mcp-packages/verified-files.js",
    "server/features/mcp-packages/cpython-relocation.js",
    "scripts/verify-mcp-toolchains.mjs",
  ];
  for (const event of ["push", "pull_request"])
    for (const file of modules)
      assert.ok(
        workflow.on[event].paths.some((pattern) => matches(pattern, file)),
        `${event}: ${file}`,
      );
});
