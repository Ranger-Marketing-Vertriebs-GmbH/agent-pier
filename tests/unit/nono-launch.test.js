import test from "node:test";
import assert from "node:assert/strict";
import {
  INSTALLATION_FILE_GRANTS,
  INSTALLATION_GRANTS,
  INSTALLATION_ROOT,
  NonoSandbox,
  grantArguments,
  wrapWithNono,
} from "../../server/features/nono/nono-launch.js";

// nono rejects a file behind a directory flag, so the composer classifies every
// grant path. The classifier is injected here: the tests pin the flag choice,
// not the state of this machine's filesystem.
const classify = (...directories) => ({
  isDirectory: (target) => directories.includes(target),
});
const nono = "/opt/homebrew/bin/nono";
const pairs = (args) =>
  args.reduce(
    (list, value, index) => (index % 2 ? [...list, [args[index - 1], value]] : list),
    [],
  );

test("grantArguments maps directory grants to the recursive nono flags", () => {
  assert.deepEqual(
    grantArguments(
      [
        { access: "allow", path: "/data" },
        { access: "read", path: "/install" },
        { access: "write", path: "/out" },
      ],
      classify("/data", "/install", "/out"),
    ),
    ["--allow", "/data", "--read", "/install", "--write", "/out"],
  );
});

test("grantArguments maps a single file to the file flags", () => {
  assert.deepEqual(
    grantArguments(
      [
        { access: "read", path: "/usr/bin/node" },
        { access: "allow", path: "/data/launch.json" },
        { access: "write", path: "/data/log.txt" },
      ],
      classify(),
    ),
    [
      "--allow-file",
      "/data/launch.json",
      "--write-file",
      "/data/log.txt",
      "--read-file",
      "/usr/bin/node",
    ],
  );
});

test("grantArguments expresses a socket grant as its own capability", () => {
  assert.deepEqual(
    grantArguments([{ access: "socket", path: "/run/bridge.sock" }], classify()),
    ["--allow-unix-socket", "/run/bridge.sock"],
  );
});

test("grantArguments expresses a socket-dir-bind grant without consulting the classifier", () => {
  // A fresh boot has not created the directory yet: if this fell through to the
  // directory/file classifier, a missing path would flip the flag on later
  // launches once something else created it, making the launch unstable.
  const explodes = {
    isDirectory() {
      throw new Error("socket-dir-bind must bypass directory classification");
    },
  };
  assert.deepEqual(
    grantArguments([{ access: "socket-dir-bind", path: "/run/bus" }], explodes),
    ["--allow-unix-socket-dir-bind", "/run/bus"],
  );
});

test("grantArguments refuses an access kind it cannot express", () => {
  assert.throws(
    () => grantArguments([{ access: "execute", path: "/bin/sh" }], classify()),
    /execute/,
  );
});

test("grantArguments is deterministic and merges repeated paths", () => {
  const directories = classify("/a", "/b");
  const first = grantArguments(
    [
      { access: "read", path: "/b" },
      { access: "allow", path: "/a" },
      { access: "socket", path: "/a" },
      { access: "allow", path: "/b" },
    ],
    directories,
  );
  const second = grantArguments(
    [
      { access: "allow", path: "/b" },
      { access: "socket", path: "/a" },
      { access: "allow", path: "/a" },
      { access: "read", path: "/b" },
    ],
    directories,
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    "--allow",
    "/a",
    "--allow-unix-socket",
    "/a",
    "--allow",
    "/b",
  ]);
});

test("wrapWithNono puts the CLI and its arguments after the separator", () => {
  const wrapped = wrapWithNono({
    launch: {
      command: "/bin/claude",
      args: ["--session-id", "abc"],
      env: { TERM: "xterm-256color" },
      sandboxGrants: [{ access: "allow", path: "/project" }],
    },
    executable: nono,
    profile: "claude-default",
    ...classify("/project", ...INSTALLATION_GRANTS),
  });
  assert.equal(wrapped.command, nono);
  const separator = wrapped.args.indexOf("--");
  assert.deepEqual(wrapped.args.slice(0, 4), [
    "wrap",
    "-p",
    "claude-default",
    "--allow-cwd",
  ]);
  assert.deepEqual(wrapped.args.slice(separator + 1), [
    "/bin/claude",
    "--session-id",
    "abc",
  ]);
  const granted = pairs(wrapped.args.slice(4, separator));
  assert.deepEqual(
    granted,
    [
      ["--allow", "/project"],
      ...INSTALLATION_GRANTS.map((path) => ["--read", path]),
      ...INSTALLATION_FILE_GRANTS.map((path) => ["--read-file", path]),
      // The wrapped CLI itself: without this, nono denies exec of any target
      // that turns out to be a shebang script rather than a compiled binary.
      ["--read-file", "/bin/claude"],
    ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
  );
  assert.deepEqual(wrapped.env, { TERM: "xterm-256color" });
  assert.equal(wrapped.sandboxGrants, undefined);
});

test("wrapWithNono grants the installation subtrees our helper scripts import from, never the installation root itself", () => {
  const wrapped = wrapWithNono({
    launch: { command: "/bin/claude", args: [], sandboxGrants: [] },
    executable: nono,
    profile: "claude-default",
    ...classify(...INSTALLATION_GRANTS),
  });
  const separator = wrapped.args.indexOf("--");
  const granted = pairs(wrapped.args.slice(4, separator));
  for (const subtree of INSTALLATION_GRANTS)
    assert.ok(
      granted.some(([flag, path]) => flag === "--read" && path === subtree),
      `expected a --read grant for ${subtree}`,
    );
  // Node walks up from a helper script to the nearest package.json, and a denied
  // read of the root one aborts the script with ERR_INVALID_PACKAGE_CONFIG, so
  // that single file is granted on its own.
  for (const file of INSTALLATION_FILE_GRANTS)
    assert.ok(
      granted.some(([flag, path]) => flag === "--read-file" && path === file),
      `expected a --read-file grant for ${file}`,
    );
  // A checkout's default data directory sits beside these subtrees, directly
  // under the installation root: granting the root itself would expose it.
  assert.equal(
    granted.some(([, path]) => path === INSTALLATION_ROOT),
    false,
  );
});

test("wrapWithNono returns the launch unchanged when no sandbox profile is given", () => {
  const wrapped = wrapWithNono({
    launch: {
      command: "/bin/claude",
      args: ["--resume", "abc"],
      env: { TERM: "xterm-256color" },
      sandboxGrants: [{ access: "allow", path: "/project" }],
    },
    executable: nono,
    profile: null,
  });
  assert.equal(wrapped.command, "/bin/claude");
  assert.deepEqual(wrapped.args, ["--resume", "abc"]);
  assert.deepEqual(wrapped.env, { TERM: "xterm-256color" });
  assert.equal(wrapped.sandboxGrants, undefined);
});

test("appending resume flags still reaches the CLI", () => {
  const wrapped = wrapWithNono({
    launch: { command: "/bin/claude", args: [], sandboxGrants: [] },
    executable: nono,
    profile: "claude-default",
    ...classify(...INSTALLATION_GRANTS),
  });
  wrapped.args.push("--resume", "abc");
  assert.deepEqual(wrapped.args.slice(-3), ["/bin/claude", "--resume", "abc"]);
});

const installed = [
  { id: "nono", name: "nono", utility: true, installed: true, path: nono },
];
const missing = [
  { id: "nono", name: "nono", utility: true, installed: false, path: null },
];

test("the adapter wraps a launch whose sandbox profile nono reports", async () => {
  const sandbox = new NonoSandbox({
    detect: () => installed,
    readProfiles: async () => ["claude-default"],
  });
  const wrapped = await sandbox.prepare({
    launch: { command: "/bin/claude", args: [], sandboxGrants: [] },
    profile: "claude-default",
  });
  assert.equal(wrapped.command, nono);
  assert.deepEqual(wrapped.args.slice(0, 4), [
    "wrap",
    "-p",
    "claude-default",
    "--allow-cwd",
  ]);
});

test("the adapter rejects a launch when nono is not installed", async () => {
  const sandbox = new NonoSandbox({
    detect: () => missing,
    readProfiles: async () => ["claude-default"],
  });
  await assert.rejects(
    sandbox.prepare({
      launch: { command: "/bin/claude", args: [] },
      profile: "claude-default",
    }),
    (error) => error.status === 400 && /nono/.test(error.message),
  );
});

test("the adapter rejects a sandbox profile nono does not report", async () => {
  const sandbox = new NonoSandbox({
    detect: () => installed,
    readProfiles: async () => ["claude-default"],
  });
  await assert.rejects(
    sandbox.prepare({
      launch: { command: "/bin/claude", args: [] },
      profile: "made-up",
    }),
    (error) => error.status === 400,
  );
});

test("the adapter leaves an unsandboxed launch alone but strips the grants", async () => {
  const sandbox = new NonoSandbox({
    detect: () => {
      throw new Error("detection must not run for an unsandboxed launch");
    },
    readProfiles: async () => [],
  });
  const launch = await sandbox.prepare({
    launch: {
      command: "/bin/claude",
      args: ["--session-id", "abc"],
      env: { TERM: "xterm-256color" },
      sandboxGrants: [{ access: "allow", path: "/project" }],
    },
    profile: null,
  });
  assert.deepEqual(launch, {
    command: "/bin/claude",
    args: ["--session-id", "abc"],
    env: { TERM: "xterm-256color" },
  });
});
