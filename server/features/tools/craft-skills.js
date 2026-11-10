import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverMessages } from "../../lib/i18n/de.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { bundledSkills, skillPack } from "../mcp-packages/package-skill-scan.js";
import { craftManifest } from "./craft-manifest.js";

// The skill Craft Anything's setup would write, adapted for AgentPier and shipped in
// AgentPier's own folder (the CLI has no npm package to carry it).
export const craftSkill = "craft-anything";
export const craftSkillRegistry = "agentpier";
const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), "craft-skill");
// Raise with every change to the shipped SKILL.md: the owned copies follow it.
const craftSkillRevision = 3;
/** The owner version of the shipped skill: the pinned Craft version and its revision. */
export const craftSkillVersion = `${craftManifest.version}+skill.${craftSkillRevision}`;

/**
 * Keeps Craft Anything's skill beside the tool, as syncReaSkills does for REA: one
 * AgentPier-owned copy in each skill profile of a CLI the managed row `serverId` is
 * bound to, none elsewhere (`serverId` null: all go). Another pinned version or skill
 * revision replaces an owned copy. A profile with the owner's own folder of that name keeps it; an owned
 * copy the owner changed is only forgotten (PackageSkills#settle). Never throws.
 */
export async function syncCraftSkills({
  serverId,
  servers,
  extensions,
  directory = shipped,
  version = craftSkillVersion,
}) {
  const owned = serverId
    ? extensions
        .installed()
        .filter((item) => item.package?.serverId === serverId && item.name === craftSkill)
    : extensions
        .installed()
        .filter(
          (item) =>
            item.package?.registry === craftSkillRegistry && item.name === craftSkill,
        );
  let targets = [];
  if (serverId) {
    try {
      const { clis } = servers.targetsOf(serverId);
      targets = extensions
        .skillProfiles()
        .filter((profile) => clis.includes(profile.tool));
    } catch (error) {
      logFailure("read the CLIs Craft Anything is bound to", error);
      return;
    }
  }
  let pack = null;
  const read = async () => {
    if (pack) return pack;
    const skill = (await bundledSkills(directory)).find(
      (item) => item.name === craftSkill,
    );
    if (!skill) throw Error("Craft Anything's shipped skill is missing");
    pack = await skillPack(skill);
    return pack;
  };
  const owner = { serverId, registry: craftSkillRegistry, name: craftSkill, version };
  for (const profile of targets) {
    const have = owned.find((item) => item.accountId === profile.id);
    try {
      if (have) {
        if (have.package.version !== version) {
          const next = await read();
          settle(extensions, have, () =>
            extensions.replaceSkill(have.accountId, have.id, next, { package: owner }),
          );
        }
        continue;
      }
      extensions.installPackageSkill(profile.id, await read(), owner);
    } catch (error) {
      // The owner's own folder of that name wins and is never retried. Anything else
      // is logged; the next sync (a binding change, a job or server start) retries.
      if (error?.message !== serverMessages.extensions.skillDirectoryAlreadyExists)
        logFailure(
          "copy Craft Anything's skill into a CLI profile (retried at the next sync)",
          error,
        );
    }
  }
  const bound = new Set(targets.map((profile) => profile.id));
  for (const item of owned)
    if (!bound.has(item.accountId))
      settle(extensions, item, () =>
        extensions.removeSkill(item.accountId, item.id, { verify: true }),
      );
}

// A folder the owner changed, moved or removed is theirs now: only the record goes.
function settle(extensions, item, change) {
  try {
    change();
  } catch (error) {
    if (error?.status === 409 || error?.status === 404 || error?.code === "ENOENT")
      extensions.forgetSkill(item.id);
    else logFailure("update Craft Anything's skill copy", error);
  }
}
