import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INSTALLATION_FILE_GRANTS,
  INSTALLATION_GRANTS,
  wrapWithNono,
} from "../../server/features/nono/nono-launch.js";

const executable = "/opt/homebrew/bin/nono";
const cliArguments = {
  codex: ["-c", 'sandbox_mode="workspace-write"'],
  claude: ["--session-id", "fixed-id"],
  opencode: ["--auto"],
  shell: [],
};

/**
 * Real paths on disk: nono refuses a file behind a directory flag, so the
 * composer classifies each grant, and a fixture of invented paths would only
 * ever exercise the single-file branch.
 */
function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-nono-launch-")),
  );
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const script = path.join(root, "hook.mjs");
  fs.writeFileSync(script, "");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { project, script, socket: path.join(root, "bridge.sock") };
}
const pairs = (args) =>
  args.reduce(
    (list, value, index) => (index % 2 ? [...list, [args[index - 1], value]] : list),
    [],
  );

for (const tool of Object.keys(cliArguments)) {
  test(`nono sandbox launch: ${tool} keeps its arguments after the separator`, (t) => {
    const { project, script, socket } = fixture(t);
    const launch = {
      command: `/fixture-bin/${tool}`,
      args: cliArguments[tool],
      env: { TERM: "xterm-256color" },
      sandboxGrants: [
        { access: "allow", path: project },
        { access: "read", path: script },
        { access: "socket", path: socket },
      ],
    };
    const wrapped = wrapWithNono({
      launch,
      executable,
      profile: `${tool}-default`,
    });
    const separator = wrapped.args.indexOf("--");
    assert.equal(wrapped.command, executable);
    assert.ok(separator > 0, "the separator must be present");
    assert.deepEqual(wrapped.args.slice(0, 4), [
      "wrap",
      "-p",
      `${tool}-default`,
      "--allow-cwd",
    ]);
    // The CLI and its own arguments survive verbatim, in order, after "--".
    assert.deepEqual(wrapped.args.slice(separator + 1), [
      `/fixture-bin/${tool}`,
      ...cliArguments[tool],
    ]);
    // No grant flag leaks past the separator, where the CLI would read it.
    assert.equal(
      wrapped.args.slice(separator + 1).some((value) => value.startsWith("--allow")),
      false,
    );
    const granted = pairs(wrapped.args.slice(4, separator));
    assert.deepEqual(granted, [
      // A directory, a single file, a socket, the installation subtrees and the
      // CLI executable itself, sorted by path so the order never follows the
      // chain. The fixture CLI path does not exist on disk, so it classifies as
      // a single file, same as a real packaged CLI would.
      ...[
        ...INSTALLATION_GRANTS.map((installationPath) => ["--read", installationPath]),
        ...INSTALLATION_FILE_GRANTS.map((file) => ["--read-file", file]),
        ["--allow", project],
        ["--read-file", script],
        ["--allow-unix-socket", socket],
        ["--read-file", `/fixture-bin/${tool}`],
      ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    ]);
    assert.deepEqual(wrapped.env, { TERM: "xterm-256color" });
    assert.equal(wrapped.sandboxGrants, undefined);
    // The composer never edits the launch it was handed.
    assert.equal(launch.command, `/fixture-bin/${tool}`);
    assert.equal(launch.sandboxGrants.length, 3);
  });
}

test("nono sandbox launch: the same grants compose the same arguments twice", (t) => {
  const { project, script, socket } = fixture(t);
  const launch = (grants) => ({
    command: "/fixture-bin/claude",
    args: ["--session-id", "fixed-id"],
    sandboxGrants: grants,
  });
  const first = wrapWithNono({
    launch: launch([
      { access: "socket", path: socket },
      { access: "read", path: script },
      { access: "allow", path: project },
      { access: "read", path: project },
    ]),
    executable,
    profile: "claude-default",
  });
  const second = wrapWithNono({
    launch: launch([
      { access: "read", path: project },
      { access: "allow", path: project },
      { access: "read", path: script },
      { access: "socket", path: socket },
    ]),
    executable,
    profile: "claude-default",
  });
  assert.deepEqual(first.args, second.args);
});

test("nono sandbox launch: an unsandboxed launch is untouched", () => {
  const wrapped = wrapWithNono({
    launch: {
      command: "/fixture-bin/claude",
      args: ["--auto"],
      env: { TERM: "xterm-256color" },
      sandboxGrants: [{ access: "allow", path: "/project" }],
    },
    executable,
    profile: null,
  });
  assert.deepEqual(wrapped, {
    command: "/fixture-bin/claude",
    args: ["--auto"],
    env: { TERM: "xterm-256color" },
  });
});
