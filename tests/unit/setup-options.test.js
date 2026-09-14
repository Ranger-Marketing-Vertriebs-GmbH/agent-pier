import test from "node:test";
import assert from "node:assert/strict";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";

const context = (overrides = {}) => ({
  home: "/Users/fixture",
  env: {},
  platform: "darwin",
  arch: "arm64",
  ...overrides,
});

test("setup options use macOS user defaults", () => {
  assert.deepEqual(resolveSetupOptions([], context()), {
    installRoot: "/Users/fixture/.local/share/agentpier-app",
    dataDir: "/Users/fixture/Library/Application Support/AgentPier",
    service: true,
    installDependencies: true,
    dependenciesOnly: false,
    resume: true,
  });
});

test("CLI paths override environment paths, which override home defaults", () => {
  const env = {
    AGENTPIER_INSTALL_ROOT: "/env/app",
    AGENTPIER_DATA_DIR: "/env/data",
  };
  assert.deepEqual(resolveSetupOptions([], context({ env })), {
    installRoot: "/env/app",
    dataDir: "/env/data",
    service: true,
    installDependencies: true,
    dependenciesOnly: false,
    resume: true,
  });
  assert.deepEqual(
    resolveSetupOptions(
      ["--install-root", "/cli/app", "--data-dir", "/cli/data"],
      context({ env }),
    ),
    {
      installRoot: "/cli/app",
      dataDir: "/cli/data",
      service: true,
      installDependencies: true,
      dependenciesOnly: false,
      resume: true,
    },
  );
});

test("setup switches service and dependency policies", () => {
  assert.deepEqual(
    resolveSetupOptions(["--no-service", "--skip-dependencies"], context()),
    {
      installRoot: "/Users/fixture/.local/share/agentpier-app",
      dataDir: "/Users/fixture/Library/Application Support/AgentPier",
      service: false,
      installDependencies: false,
      dependenciesOnly: false,
      resume: true,
    },
  );
  assert.equal(
    resolveSetupOptions(["--dependencies-only"], context()).dependenciesOnly,
    true,
  );
});

for (const [name, args, message] of [
  ["unknown options", ["--wat"], /Unknown setup option/],
  ["missing values", ["--data-dir"], /requires a value/],
  ["relative roots", ["--install-root", "relative"], /absolute/],
  ["relative data", ["--data-dir", "relative"], /absolute/],
  [
    "data equal to root",
    ["--install-root", "/place/app", "--data-dir", "/place/app"],
    /outside the install root/,
  ],
  [
    "data below root",
    ["--install-root", "/place/app", "--data-dir", "/place/app/data"],
    /outside the install root/,
  ],
  [
    "dependency-only path options",
    ["--dependencies-only", "--data-dir", "/place/data"],
    /cannot be combined/,
  ],
  [
    "dependency-only service options",
    ["--dependencies-only", "--no-service"],
    /cannot be combined/,
  ],
  [
    "dependency-only skip",
    ["--dependencies-only", "--skip-dependencies"],
    /cannot be combined/,
  ],
])
  test(`setup rejects ${name}`, () => {
    assert.throws(() => resolveSetupOptions(args, context()), message);
  });

test("setup rejects unsupported runtime platforms and architectures", () => {
  assert.throws(() => resolveSetupOptions([], context({ platform: "linux" })), /macOS/);
  assert.throws(() => resolveSetupOptions([], context({ arch: "mips" })), /architecture/);
});

test("installer arguments pin the first release while retaining setup defaults", () => {
  const args = installerArguments(resolveSetupOptions([], context()), "1.17.0");
  assert.deepEqual(args, [
    "--install-root",
    "/Users/fixture/.local/share/agentpier-app",
    "--data-dir",
    "/Users/fixture/Library/Application Support/AgentPier",
    "--resume",
    "--initial-channel",
    "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/download/v1.17.0/",
    "--service",
  ]);
});

test("dependency repair omits release, path, resume, and service arguments", () => {
  const options = resolveSetupOptions(["--dependencies-only"], context());
  assert.deepEqual(installerArguments(options, "1.17.0"), ["--dependencies-only"]);
});
