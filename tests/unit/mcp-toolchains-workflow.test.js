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
    // The Node toolchain pin is the agent runtime's Node.
    "server/features/assistants/runtime-manifest.js",
  ];
  for (const event of ["push", "pull_request"])
    for (const file of modules)
      assert.ok(
        workflow.on[event].paths.some((pattern) => matches(pattern, file)),
        `${event}: ${file}`,
      );
});

test("the Python install tests run natively against the local index and trigger the workflow", () => {
  const verify = steps.findIndex((step) =>
    step.run?.includes("verify-mcp-toolchains.mjs"),
  );
  const index = steps.findIndex((step) =>
    step.run?.includes("mcp-python-packages.test.js"),
  );
  assert.ok(index > verify, "after the toolchain check");
  assert.equal(steps[index].env?.AGENTPIER_MCP_PYTHON_TESTS, "1");
  assert.match(
    steps[index].run,
    /^node --test tests\/integration\/mcp-python-packages\.test\.js$/,
  );
  for (const event of ["push", "pull_request"])
    for (const file of [
      "server/features/mcp-packages/python-adapter.js",
      "server/features/mcp-packages/python-package-install.js",
      "server/features/mcp-packages/python-lock-check.js",
      "server/features/mcp-packages/wheel-programs.js",
      "server/features/mcp-packages/package-store.js",
      "server/features/mcp-packages/package-install-job.js",
      "server/features/mcp-packages/mcp-packages.js",
      "tests/integration/mcp-python-packages.test.js",
      "tests/helpers/pypi-index-fixture.js",
      "tests/helpers/mcp-python-service.js",
    ])
      assert.ok(
        workflow.on[event].paths.some((pattern) => matches(pattern, file)),
        `${event}: ${file}`,
      );
});
