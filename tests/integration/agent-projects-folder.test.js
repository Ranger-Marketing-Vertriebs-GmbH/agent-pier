import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { agentProjectFixture } from "../helpers/agent-project-fixture.js";
import { initRepository } from "../../server/features/assistants/agent-projects.js";

// The agentpier_project service (agent-projects.js) works only on the folder its call
// made: never on a link or another folder put in its place, and its rollback removes
// nothing else.

const entries = (dir) => fs.readdirSync(dir).sort();

test("a folder swapped for a link or another folder is refused and the replacement stays", async (t) => {
  const f = await agentProjectFixture(t);
  const logged = t.mock.method(console, "error", () => {});
  const outside = fs.mkdtempSync(path.join(f.dataDir, "outside-"));
  fs.writeFileSync(path.join(outside, "keep"), "x");
  const known = f.projectIds();
  let removed;
  const swaps = {
    link: (target) => fs.symlinkSync(outside, target),
    folder: (target) => {
      fs.mkdirSync(target);
      // The call still holds the removed folder open, so its inode number is never
      // handed on (ext4 would reuse a freed one at once).
      assert.notEqual(fs.lstatSync(target).ino, removed);
      fs.writeFileSync(path.join(target, "theirs"), "y");
    },
  };
  // Swapped after git init: refused before registering.
  for (const [kind, swap] of Object.entries(swaps)) {
    f.workflows.projects.gitInit = async (target) => {
      removed = fs.lstatSync(target).ino;
      fs.rmdirSync(target);
      swap(target);
    };
    assert.equal(
      await f.code(f.call({ action: "create", name: `After-${kind}` })),
      "PROJECT_FOLDER_UNAVAILABLE",
      kind,
    );
  }
  // Swapped before git init: git never runs.
  let inits = 0;
  f.workflows.projects.gitInit = async () => inits++;
  const unchanged = f.workflows.projects.unchanged.bind(f.workflows.projects);
  f.workflows.projects.unchanged = async (target, made) => {
    f.workflows.projects.unchanged = unchanged;
    fs.rmdirSync(target);
    swaps.link(target);
    return unchanged(target, made);
  };
  assert.equal(
    await f.code(f.call({ action: "create", name: "Before" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.equal(inits, 0);
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
  // The rollback removes only the folder the call made, never what replaced it.
  assert.deepEqual(entries(f.parent), ["After-folder", "After-link", "Before"]);
  assert.deepEqual(fs.readdirSync(path.join(f.parent, "After-folder")), ["theirs"]);
  for (const link of ["After-link", "Before"])
    assert.equal(fs.readlinkSync(path.join(f.parent, link)), outside);
  assert.equal(logged.mock.callCount(), 3);
  assert.deepEqual(f.projectIds(), known);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
});

test("the new folder stays open, without following links, until the call ends", async (t) => {
  const f = await agentProjectFixture(t);
  const events = [];
  const open = fsp.open;
  t.mock.method(fsp, "open", async (file, flags, ...rest) => {
    const handle = await open(file, flags, ...rest);
    if (path.dirname(String(file)) !== f.parent) return handle;
    events.push(["open", path.basename(file), flags]);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      events.push(["close", path.basename(file)]);
      return close();
    };
    return handle;
  });
  f.workflows.projects.gitInit = async (target) => {
    events.push(["git", path.basename(target)]);
    if (path.basename(target) === "Fails") throw Error("boom");
    return initRepository(target);
  };
  const flags =
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  await f.call({ action: "create", name: "Shop" });
  assert.equal(
    await f.code(f.call({ action: "create", name: "Fails" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.deepEqual(events, [
    ["open", "Shop", flags],
    ["git", "Shop"],
    ["close", "Shop"],
    ["open", "Fails", flags],
    ["git", "Fails"],
    ["close", "Fails"],
  ]);
  assert.deepEqual(entries(f.parent), ["Shop"]);
});
