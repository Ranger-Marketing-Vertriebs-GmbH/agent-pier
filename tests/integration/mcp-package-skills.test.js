import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPackaged,
  packageService,
  preview,
  v1,
} from "../helpers/mcp-packages-service.js";
import { bundledSkills } from "../../server/features/mcp-packages/package-skill-scan.js";

const skill = (description, extra = "") =>
  `---\nname: reverse-it\ndescription: ${description}\n---\n# Steps\n${extra}`;
const helper = { name: "helper", version: "1.0.0", files: { "i.js": "" } };
// Like REA (npm rea-agents): the server package ships a skill folder beside its code.
const withSkill = {
  ...v1,
  files: {
    "index.js": "",
    "skills/reverse-it/SKILL.md": skill("Reverse engineer a program."),
    "skills/reverse-it/guide.md": "Read the binary first.",
    // Not offered: a skill carrying MCP configuration, and invalid metadata.
    "skills/sneaky/SKILL.md": skill("Sneaky.").replace("reverse-it", "sneaky"),
    "skills/sneaky/.mcp.json": "{}",
    "skills/broken/SKILL.md": "no frontmatter",
  },
  dependencies: { helper: "1.0.0" },
};
const v2 = {
  ...withSkill,
  version: "2.0.0",
  files: {
    "index.js": "",
    "skills/reverse-it/SKILL.md": skill("Reverse engineer, version two."),
  },
};
const v3 = { ...withSkill, version: "3.0.0", files: { "index.js": "" } };
const target = (s) => path.join(s.home, ".claude", "skills", "reverse-it");

async function installed(t) {
  const s = await packageService(t, [withSkill, v2, v3, helper]);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  return { s, server };
}
const update = async (s, id, version) => {
  const next = await preview(s, version, { serverId: id });
  await s.packages.updatePackage(id, { version, previewId: next.previewId });
  await s.packages.jobs.idle();
};

test("an installed package offers its valid bundled skills and installs only on confirmation", async (t) => {
  const { s, server } = await installed(t);
  const offered = s.packages.skills.list(server.id);
  assert.equal(offered.version, "1.0.0");
  assert.deepEqual(
    offered.skills.map(({ name, description, files, installed }) => ({
      name,
      description,
      files,
      installed,
    })),
    [
      {
        name: "reverse-it",
        description: "Reverse engineer a program.",
        files: ["SKILL.md", "guide.md"],
        installed: [],
      },
    ],
  );
  assert.ok(offered.profiles.some((profile) => profile.id === "local-claude"));
  // The listing names no host path.
  assert.equal(JSON.stringify(offered).includes(s.root), false);
  assert.throws(
    () =>
      s.packages.skills.install(server.id, {
        profileId: "local-claude",
        names: ["reverse-it"],
      }),
    { code: "MCP_PACKAGE_CONFIRMATION_REQUIRED" },
  );
  assert.equal(fs.existsSync(target(s)), false);
  assert.throws(
    () =>
      s.packages.skills.install(server.id, {
        profileId: "local-claude",
        names: ["sneaky"],
        confirmInstall: true,
      }),
    { status: 404 },
  );
  s.packages.skills.install(server.id, {
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
  assert.equal(
    fs.readFileSync(path.join(target(s), "guide.md"), "utf8"),
    "Read the binary first.",
  );
  const row = s.extensions
    .list("local-claude")
    .skills.items.find((item) => item.name === "reverse-it");
  assert.deepEqual(row.package, { name: "server-x", version: "1.0.0" });
  assert.equal(row.removable, true);
  assert.deepEqual(
    s.packages.skills.list(server.id).skills[0].installed.map((entry) => entry.profileId),
    ["local-claude"],
  );
});

test("a package update brings its skill along and a version without it removes it", async (t) => {
  const { s, server } = await installed(t);
  s.packages.skills.install(server.id, {
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
  await update(s, server.id, "2.0.0");
  assert.match(fs.readFileSync(path.join(target(s), "SKILL.md"), "utf8"), /version two/);
  // Files the new version no longer ships go with the old version.
  assert.equal(fs.existsSync(path.join(target(s), "guide.md")), false);
  const row = s.extensions
    .list("local-claude")
    .skills.items.find((item) => item.name === "reverse-it");
  assert.deepEqual(row.package, { name: "server-x", version: "2.0.0" });
  assert.equal(row.description, "Reverse engineer, version two.");
  await update(s, server.id, "3.0.0");
  assert.equal(fs.existsSync(target(s)), false);
  assert.equal(
    s.extensions.installed().some((item) => item.name === "reverse-it"),
    false,
  );
});

test("removing the package or its server removes the skills it installed", async (t) => {
  const { s, server } = await installed(t);
  s.packages.skills.install(server.id, {
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
  // A skill the owner installed by hand under another name stays.
  const own = path.join(s.home, ".claude", "skills", "own");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(
    path.join(own, "SKILL.md"),
    skill("Mine.").replace("reverse-it", "own"),
  );
  await s.changes.remove(server.id);
  assert.equal(fs.existsSync(target(s)), false);
  assert.equal(fs.existsSync(own), true);
  assert.deepEqual(s.extensions.installed(), []);
});

test("a skill folder the owner replaced is never overwritten by an update", async (t) => {
  const { s, server } = await installed(t);
  s.packages.skills.install(server.id, {
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
  fs.rmSync(target(s), { recursive: true });
  fs.mkdirSync(target(s));
  fs.writeFileSync(path.join(target(s), "SKILL.md"), skill("The owner's own."));
  await update(s, server.id, "2.0.0");
  assert.match(fs.readFileSync(path.join(target(s), "SKILL.md"), "utf8"), /owner's own/);
  // The package no longer owns it: a later removal leaves it alone as well.
  assert.deepEqual(s.extensions.installed(), []);
});

test("switching the server to an own command removes the package's skills", async (t) => {
  const { s, server } = await installed(t);
  s.packages.skills.install(server.id, {
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
  const ready = s.servers.get(server.id);
  await s.packages.detach(server.id, () =>
    s.changes.update(
      server.id,
      { revision: ready.revision, command: "/fake/bin/own", args: [] },
      { confirmStdio: true },
    ),
  );
  assert.equal(fs.existsSync(target(s)), false);
  assert.deepEqual(s.extensions.installed(), []);
});

test("bundled skills never follow links or include nested packages", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-package-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  write("skills/linked/SKILL.md", skill("Linked.").replace("reverse-it", "linked"));
  fs.symlinkSync("/etc/hosts", path.join(root, "skills/linked/hosts"));
  write("skills/nested/SKILL.md", skill("Nested.").replace("reverse-it", "nested"));
  write("skills/nested/node_modules/x/index.js", "");
  write("node_modules/dep/SKILL.md", skill("A dependency."));
  write("a/reverse-it/SKILL.md", skill("Twice."));
  write("b/reverse-it/SKILL.md", skill("Twice."));
  write("docs/plain/SKILL.md", skill("Plain.").replace("reverse-it", "plain"));
  fs.symlinkSync(path.join(root, "docs"), path.join(root, "loop"));
  assert.deepEqual(
    bundledSkills(root).map((found) => found.name),
    ["plain"],
  );
});
