import fs from "node:fs";
import path from "node:path";

/**
 * OpenClaw 2026.11.3 prepares agents one by one after a Doctor migration, once the
 * Gateway listens. Its startup loop (agent-database-startup-*.mjs) retries a
 * publication only when it was superseded by its own check
 * (`AgentDatabaseStartupSupersededError`); a concurrent model runtime refresh, such as
 * `models.authRefresh`, makes `publishAgent` throw
 * `PreparedModelRuntimePublicationSupersededError` instead, and the agent stays
 * degraded until the Gateway restarts. AgentPier's `superseded-publication-retry`
 * patch (runtime-bundle-patches.js) retries that refusal too. This guard reads the
 * installed package itself, independent of the patch list, so a pin bump that would
 * silently drop the patch fails until it is carried forward or upstream retries (or
 * joins) superseded publications on its own.
 */
const retry =
  /if \(!\((.*?)\) \|\| attempt >= STARTUP_PUBLICATION_ATTEMPTS\) throw error;/g;

function* scripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(file);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) yield file;
  }
}

/**
 * Every startup publication retry in the package's `dist`, as `{ file, retried }`:
 * `file` relative to `packageDir`, `retried` whether its condition retries a
 * superseded model runtime publication.
 */
export function supersededPublicationSites(packageDir) {
  const found = [];
  for (const file of scripts(path.join(packageDir, "dist"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("STARTUP_PUBLICATION_ATTEMPTS")) continue;
    for (const [, condition] of text.matchAll(retry))
      found.push({
        file: path.relative(packageDir, file).split(path.sep).join("/"),
        retried: condition.includes("PreparedModelRuntimePublicationSupersededError"),
      });
  }
  return found;
}

/**
 * Throws unless every startup publication retry of the package retries a superseded
 * model runtime publication. Finding none fails too: upstream may have renamed or
 * moved the loop, and the guard must then be updated rather than pass silently.
 */
export function assertSupersededPublicationRetried(packageDir) {
  const found = supersededPublicationSites(packageDir);
  if (!found.length)
    throw Error(
      `No agent database startup publication retry found in ${packageDir}/dist; update the superseded publication guard.`,
    );
  const missing = found.filter((site) => !site.retried);
  if (missing.length)
    throw Error(
      `OpenClaw leaves an agent degraded when a concurrent refresh supersedes its startup publication: ${missing
        .map((site) => site.file)
        .join(
          ", ",
        )}. Carry the superseded-publication-retry patch forward (runtime-bundle-patches.js).`,
    );
  return found;
}
