import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { compareReleaseVersions } from "../server/features/operations/version.js";

/**
 * Installations that activated a published release candidate may already run on
 * its data schema. The final release and every later candidate of the same version
 * must therefore still accept that schema, or those installations are stranded
 * without an update or rollback path.
 */
export async function requireSchemaContinuity({ tag, manifest, repo, run }) {
  const version = tag.slice(1),
    core = version.split("-")[0];
  const listed = JSON.parse(
    await run([
      "release",
      "list",
      "--repo",
      repo,
      "--json",
      "tagName,isDraft,isPrerelease",
      "--limit",
      "1000",
    ]),
  );
  if (!Array.isArray(listed)) throw Error("Unexpected release list.");
  const earlier = listed
    .filter(
      (release) =>
        release?.isDraft === false &&
        typeof release.tagName === "string" &&
        new RegExp(`^v${core.replaceAll(".", "\\.")}-rc\\.(?:0|[1-9]\\d*)$`).test(
          release.tagName,
        ) &&
        compareReleaseVersions(release.tagName.slice(1), version) < 0,
    )
    .map((release) => release.tagName);
  if (!earlier.length) return [];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-schema-check-"));
  try {
    for (const candidate of earlier) {
      const directory = path.join(temporary, candidate);
      await fs.mkdir(directory);
      await run([
        "release",
        "download",
        candidate,
        "--repo",
        repo,
        "--pattern",
        "latest.json",
        "--dir",
        directory,
      ]);
      const published = JSON.parse(
        await fs.readFile(path.join(directory, "latest.json"), "utf8"),
      );
      if (!Number.isSafeInteger(published?.schemaMax))
        throw Error(
          `Cannot verify data schema continuity: ${candidate} does not declare its schema range in latest.json.`,
        );
      if (
        manifest.schemaMin > published.schemaMax ||
        manifest.schemaMax < published.schemaMax
      )
        throw Error(
          `${tag} accepts data schemas ${manifest.schemaMin}-${manifest.schemaMax}, but the published ${candidate} may already have migrated installations to schema ${published.schemaMax}. A schema shipped in a published release candidate is frozen; ${tag} must accept it.`,
        );
    }
    return earlier;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
