import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesTagCommit,
  refreshHermesRuntimeLock,
} from "../../scripts/refresh-hermes-runtime-lock.mjs";

const a = "a".repeat(40);
const b = "b".repeat(40);
// `git ls-remote` as a fake: an annotated tag lists its own object and the commit.
const lsRemote =
  (lines, calls = []) =>
  async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: lines.join("\n") };
  };

test("a release tag pins the commit it names, an annotated tag's peeled one", async () => {
  const calls = [];
  const annotated = lsRemote(
    [`${a}\trefs/tags/v0.22.5`, `${b}\trefs/tags/v0.22.5^{}`],
    calls,
  );
  assert.equal(await hermesTagCommit("v0.22.5", annotated), b);
  assert.deepEqual(calls[0].slice(0, 2), ["git", "ls-remote"]);
  assert.equal(await hermesTagCommit("v1.0.0", lsRemote([`${a}\trefs/tags/v1.0.0`])), a);
  await assert.rejects(hermesTagCommit("v9.9.9", lsRemote([])), /no tag v9\.9\.9/);
  for (const tag of ["main", "v0.22", "v0.22.5; rm"])
    await assert.rejects(hermesTagCommit(tag, lsRemote([])), /release tag/);
});

test("a commit given beside a tag must be the one the tag names", async () => {
  const execute = lsRemote([`${b}\trefs/tags/v0.22.5^{}`]);
  await assert.rejects(
    refreshHermesRuntimeLock({
      tag: "v0.22.5",
      commit: a,
      execute,
      download: async () => assert.fail("nothing is downloaded"),
    }),
    /names b+, not a+/,
  );
});
