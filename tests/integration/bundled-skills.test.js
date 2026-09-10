import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { profileLocation } from "../../server/features/cli-profiles/configuration.js";
import { skillMetadata } from "../../server/features/extensions/skill-packages.js";

const name = "agentpier-composer";
const bundled = fs.readFileSync(
  new URL(`../../server/features/cli-profiles/skills/${name}/SKILL.md`, import.meta.url),
);

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool} receives the bundled skill in native and managed sessions, preserving edits and deletions`, async (t) => {
    const f = await applicationFixture(t);
    const { accounts, sharedProfiles } = f.application;
    const local = accounts.get(`local-${tool}`);
    const root = profileLocation(accounts, local.id).root;
    const file = path.join(root, "skills", name, "SKILL.md");
    assert.equal(fs.existsSync(file), false);
    sharedProfiles.prepare(local, {});
    assert.deepEqual(fs.readFileSync(file), bundled);
    assert.equal(skillMetadata(bundled).name, name);
    const account = accounts.create({ name: "Managed", tool });
    sharedProfiles.prepare(account, {});
    const managedFile = path.join(
      profileLocation(accounts, account.id).root,
      "skills",
      name,
      "SKILL.md",
    );
    assert.equal(fs.realpathSync(managedFile), fs.realpathSync(file));
    fs.writeFileSync(file, "User customization");
    await f.restart();
    f.application.sharedProfiles.prepare(f.application.accounts.get(account.id), {});
    assert.equal(fs.readFileSync(managedFile, "utf8"), "User customization");
    fs.rmSync(path.dirname(file), { recursive: true });
    await f.restart();
    f.application.sharedProfiles.prepare(f.application.accounts.get(local.id), {});
    f.application.sharedProfiles.prepare(f.application.accounts.get(account.id), {});
    assert.equal(fs.existsSync(file), false);
  });

  test(`${tool} preserves a pre-existing native package without adding bundled files`, async (t) => {
    const f = await applicationFixture(t);
    const { accounts, sharedProfiles } = f.application;
    const local = accounts.get(`local-${tool}`);
    const directory = path.join(profileLocation(accounts, local.id).root, "skills", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "custom.txt"), "Existing package");
    sharedProfiles.prepare(local, {});
    assert.deepEqual(fs.readdirSync(directory), ["custom.txt"]);
  });

  test(`${tool} imports an existing managed composer before seeding defaults`, async (t) => {
    const f = await applicationFixture(t);
    const { accounts, sharedProfiles } = f.application;
    const account = accounts.create({ name: "Existing", tool });
    const relative = path.join("skills", name, "SKILL.md");
    const file = path.join(profileLocation(accounts, account.id).root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "Existing managed composer");
    sharedProfiles.prepare(account, {});
    assert.equal(fs.readFileSync(file, "utf8"), "Existing managed composer");
    assert.equal(
      fs.readFileSync(
        path.join(profileLocation(accounts, `local-${tool}`).root, relative),
        "utf8",
      ),
      "Existing managed composer",
    );
  });
}

test("bundled seeding rejects a linked skills root without writing outside the native profile", async (t) => {
  const f = await applicationFixture(t);
  const { accounts, sharedProfiles } = f.application;
  const account = accounts.get("local-claude");
  const root = profileLocation(accounts, account.id).root;
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(outside, path.join(root, "skills"));
  assert.throws(() => sharedProfiles.prepare(account, {}), { status: 409 });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("shell preparation does not install bundled skills", async (t) => {
  const f = await applicationFixture(t);
  const launch = {};
  assert.equal(f.application.sharedProfiles.prepare({ tool: "shell" }, launch), launch);
  assert.equal(fs.existsSync(path.join(f.dataDir, "bundled-skills.json")), false);
});
