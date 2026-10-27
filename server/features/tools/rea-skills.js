import { logFailure } from "../mcp-packages/package-install-job.js";

// The skill REA's npm package ships for the coding CLIs (AGENTPIER-104).
export const reaSkill = "reverse-engineer-anything";

/**
 * Keeps REA's skill beside REA itself: one package-owned copy in each skill profile
 * of a CLI the managed row `serverId` is bound to, none elsewhere. A profile with the
 * owner's own folder of that name (409) keeps it; an owned copy the owner changed is
 * only forgotten when its CLI is unbound (PackageSkills#settle). Never throws.
 */
export async function syncReaSkills({ serverId, servers, packageSkills, extensions }) {
  if (!serverId || !packageSkills) return;
  let clis;
  try {
    clis = servers.targetsOf(serverId).clis;
  } catch (error) {
    logFailure("read the CLIs REA is bound to", error);
    return;
  }
  const targets = extensions
    .skillProfiles()
    .filter((profile) => clis.includes(profile.tool));
  const owned = packageSkills.owned(serverId).filter((item) => item.name === reaSkill);
  for (const profile of targets) {
    if (owned.some((item) => item.accountId === profile.id)) continue;
    try {
      await packageSkills.install(serverId, {
        profileId: profile.id,
        names: [reaSkill],
        confirmInstall: true,
      });
    } catch (error) {
      // The owner's own folder of that name wins; a busy package is retried later.
      if (error?.status !== 409) logFailure("copy REA's skill into a CLI profile", error);
    }
  }
  const bound = new Set(targets.map((profile) => profile.id));
  for (const item of owned)
    if (!bound.has(item.accountId))
      packageSkills.settle(item, () =>
        extensions.removeSkill(item.accountId, item.id, { verify: true }),
      );
}
