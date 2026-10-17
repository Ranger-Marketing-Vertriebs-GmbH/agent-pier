import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubHelperLocation } from "../../server/features/repositories/github-helper-location.js";

function installation(t, { link = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ghl-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, "releases", "1.0.0");
  fs.mkdirSync(path.join(release, "bin"), { recursive: true });
  fs.mkdirSync(path.join(release, "server"));
  fs.writeFileSync(path.join(release, "bin", "node"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(release, "server", "github-credentials.js"), "");
  if (link) fs.symlinkSync("releases/1.0.0", path.join(root, "current"));
  return { root, release };
}

test("an installed release starts the helper through the install root's current link", (t) => {
  const { root, release } = installation(t);
  const location = githubHelperLocation({
    installRoot: root,
    applicationRoot: release,
    execPath: path.join(release, "bin", "node"),
  });
  assert.deepEqual(location, {
    node: path.join(root, "current", "bin", "node"),
    script: path.join(root, "current", "server", "github-credentials.js"),
    stable: true,
    reads: [path.join(root, "current"), path.join(root, "releases")],
  });
  assert.equal(location.node.includes("1.0.0"), false);
});

test("source checkouts and incomplete installations keep their own paths", (t) => {
  const { root, release } = installation(t, { link: false });
  const checkout = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ghs-")),
  );
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const pinned = (applicationRoot) => ({
    node: "/runtime/node",
    script: path.join(applicationRoot, "server", "github-credentials.js"),
    stable: false,
    reads: [
      "/runtime/node",
      path.join(applicationRoot, "server", "github-credentials.js"),
    ],
  });
  for (const [installRoot, applicationRoot] of [
    [undefined, checkout],
    // No current link yet.
    [root, release],
    // A checkout started with an unrelated install root in its environment.
    [root, checkout],
  ])
    assert.deepEqual(
      githubHelperLocation({ installRoot, applicationRoot, execPath: "/runtime/node" }),
      pinned(applicationRoot),
    );
});
