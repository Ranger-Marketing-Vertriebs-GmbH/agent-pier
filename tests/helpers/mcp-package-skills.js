import path from "node:path";
import { createPackaged, packageService, preview, v1 } from "./mcp-packages-service.js";

export const skill = (description, extra = "", name = "reverse-it") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Steps\n${extra}`;
const helper = { name: "helper", version: "1.0.0", files: { "i.js": "" } };
// Like REA (npm rea-agents): the server package ships a skill folder beside its code.
export const withSkill = {
  ...v1,
  files: {
    "index.js": "",
    "skills/reverse-it/SKILL.md": skill("Reverse engineer a program."),
    "skills/reverse-it/guide.md": "Read the binary first.",
    "skills/second/SKILL.md": skill("A second skill.", "", "second"),
    // Not offered: a skill carrying MCP configuration, and invalid metadata.
    "skills/sneaky/SKILL.md": skill("Sneaky.", "", "sneaky"),
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
export const skillDir = (s, name = "reverse-it") =>
  path.join(s.home, ".claude", "skills", name);

/** A ready packaged server whose 1.0.0 ships reverse-it and second (2.0.0, 3.0.0 less). */
export async function installed(t) {
  const s = await packageService(t, [withSkill, v2, v3, helper]);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  return { s, server };
}
export async function update(s, id, version) {
  const next = await preview(s, version, { serverId: id });
  await s.packages.updatePackage(id, { version, previewId: next.previewId });
  await s.packages.jobs.idle();
}
export const installSkills = (s, id, names = ["reverse-it"], extra = {}) =>
  s.packages.skills.install(id, {
    profileId: "local-claude",
    names,
    confirmInstall: true,
    ...extra,
  });
