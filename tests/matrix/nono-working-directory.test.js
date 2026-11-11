// test-runner-timeout-ms: 300000
// Starts real sandboxes and child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { diffStat } from "../../server/features/changes/git-read.js";
import { setRepositoryConfinement } from "../../server/lib/git-repository-programs.js";

/**
 * Where a sandboxed session works, asked of a real nono: a profile's `workdir`
 * field defaults to `none`, and nono then starts the process in `/` instead of the
 * session's folder (nono 0.79.0 and 0.81.0; the built-in `default` profile is such a
 * profile). Skipped without the binary, like nono-confinement.test.js.
 */
function nonoExecutable() {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean))
    try {
      const candidate = path.join(directory, "nono");
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  return null;
}
const executable = nonoExecutable();
const reason = !executable
  ? "nono is not installed"
  : !["darwin", "linux"].includes(process.platform)
    ? `nono does not support ${process.platform}`
    : null;
const options = reason ? { skip: reason } : {};

// Grants nothing of its own beyond what lets a binary start; `workdir` is the
// field under test. `null` leaves it out, as the built-in `default` profile does.
const profileWith = (access) => ({
  meta: { name: "agentpier-working-directory" },
  groups: { include: ["system_read_macos", "system_read_linux_core"], exclude: [] },
  ...(access ? { workdir: { access } } : {}),
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network: { block: false },
});

// Outside every grant AgentPier composes and outside the built-in profiles' own
// (see nono-confinement.test.js): the shared temporary folder would be writable
// under `default` whatever the working directory's level is.
function workspace(t, access) {
  const scratch = path.join(INSTALLATION_ROOT, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "nono-workdir-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "in-workspace.txt"), "workspace");
  const profile = path.join(root, "profile.json");
  fs.writeFileSync(profile, JSON.stringify(profileWith(access)));
  return { root, profile, cwd };
}

const script = [
  'echo "CWD:$(pwd)"',
  'echo "READ:$(cat in-workspace.txt 2>&1)"',
  'echo "WRITE:$( (echo planted > in-workspace.txt) 2>&1 && echo written)"',
].join("\n");

function run({ profile, cwd }) {
  const wrapped = wrapWithNono({
    launch: { command: "/bin/sh", args: ["-c", script] },
    executable,
    profile,
    cwd,
  });
  try {
    return execFileSync(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NONO_THEME: "minimal" },
    });
  } catch (error) {
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}
const assertWorksIn = (output, cwd) => {
  assert.equal(/^CWD:(.*)$/m.exec(output)?.[1], cwd, output);
  assert.match(output, /^READ:workspace$/m);
};
const assertReadOnly = (output, cwd) => {
  assert.match(output, /^WRITE:.*(not permitted|denied)/im);
  assert.equal(fs.readFileSync(path.join(cwd, "in-workspace.txt"), "utf8"), "workspace");
};

for (const [name, access] of [
  ["a profile without a `workdir` field", null],
  ['a profile with `workdir.access` "none"', "none"],
])
  test(`${name} starts the session in its folder, read-only`, options, (t) => {
    const { profile, cwd } = workspace(t, access);
    const output = run({ profile, cwd });
    assertWorksIn(output, cwd);
    assertReadOnly(output, cwd);
  });

test(
  "nono's built-in `default` profile starts the session in its folder, read-only",
  options,
  (t) => {
    const { cwd } = workspace(t, null);
    const output = run({ profile: "default", cwd });
    assertWorksIn(output, cwd);
    assertReadOnly(output, cwd);
  },
);

test("a profile with a read-only working directory keeps it read-only", options, (t) => {
  const { profile, cwd } = workspace(t, "read");
  const output = run({ profile, cwd });
  assertWorksIn(output, cwd);
  assertReadOnly(output, cwd);
});

test("a profile with a read-write working directory keeps it writable", options, (t) => {
  const { profile, cwd } = workspace(t, "readwrite");
  const output = run({ profile, cwd });
  assertWorksIn(output, cwd);
  assert.match(output, /^WRITE:written$/m);
  assert.equal(
    fs.readFileSync(path.join(cwd, "in-workspace.txt"), "utf8").trim(),
    "planted",
  );
});

test(
  "the server's git runs a repository's filter in the working tree under a profile without `workdir`",
  options,
  async (t) => {
    const { profile, cwd } = workspace(t, null);
    // The filter lives in the working tree and upper-cases, as the committed blob
    // is: the unchanged file reads as unchanged only while the filter really runs,
    // and it runs only where `./filter.sh` resolves.
    fs.writeFileSync(path.join(cwd, "filter.sh"), "#!/bin/sh\ntr a-z A-Z\n", {
      mode: 0o700,
    });
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      });
    git("init", "--quiet", "-b", "main");
    git("config", "filter.upper.clean", "./filter.sh");
    fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt filter=upper\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "first");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(cwd, "in-workspace.txt"), later, later);
    t.after(() => setRepositoryConfinement(null));
    setRepositoryConfinement(async () => ({ executable, profile }));
    assert.equal((await diffStat(cwd, "HEAD")).files, 0);
  },
);
