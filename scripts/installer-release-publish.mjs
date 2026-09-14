import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { compareReleaseVersions } from "../server/features/operations/version.js";
import { validateInstallerRelease } from "./installer-release-check.mjs";
import { isMainModule } from "../server/lib/is-main-module.js";
const execute = promisify(execFile);
const gh = async (args) =>
  (await execute("gh", args, { maxBuffer: 4 * 1024 * 1024 })).stdout;

export async function publishInstallerRelease({
  directory,
  tag,
  repo = "Ranger-Marketing-Vertriebs-GmbH/agent-pier",
  run = gh,
}) {
  const files = await validateInstallerRelease({ directory, tag });
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo))
    throw Error("Invalid release repository.");
  const inspect = async () => {
    const value = JSON.parse(
      await run([
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "isDraft,tagName,assets",
      ]),
    );
    return { draft: value.isDraft, tag_name: value.tagName, assets: value.assets };
  };
  let release;
  try {
    release = await inspect();
  } catch (error) {
    if (!/HTTP 404|release not found/i.test(`${error.message}\n${error.stderr || ""}`))
      throw error;
    await run([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--draft",
      "--verify-tag",
      "--generate-notes",
    ]);
    release = await inspect();
  }
  if (
    release.tag_name !== tag ||
    typeof release.draft !== "boolean" ||
    !Array.isArray(release.assets)
  )
    throw Error("Unexpected release state.");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-release-verify-"));
  try {
    const verify = async (record) => {
      const destination = path.join(temporary, record.file);
      await fs.rm(destination, { force: true });
      await run([
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "--pattern",
        record.file,
        "--dir",
        temporary,
      ]);
      const stat = await fs.lstat(destination);
      if (!stat.isFile() || stat.size !== record.bytes)
        throw Error(`Uploaded asset size mismatch: ${record.file}`);
      const digest = createHash("sha256")
        .update(await fs.readFile(destination))
        .digest("hex");
      if (digest !== record.sha256)
        throw Error(`Uploaded asset checksum mismatch: ${record.file}`);
    };
    const missing = [];
    for (const record of files) {
      if (release.assets.some((asset) => asset.name === record.file))
        await verify(record);
      else missing.push(record);
    }
    if (!release.draft) {
      if (missing.length)
        throw Error(
          "Published release is incomplete; immutable assets will not be overwritten.",
        );
      return { published: false, tag };
    }
    if (missing.length)
      await run([
        "release",
        "upload",
        tag,
        ...missing.map((record) => path.join(directory, record.file)),
        "--repo",
        repo,
      ]);
    for (const record of missing) await verify(record);
    let latest = !tag.includes("-");
    try {
      const current = JSON.parse(
        await run(["release", "view", "--repo", repo, "--json", "tagName"]),
      );
      latest =
        latest &&
        compareReleaseVersions(tag.slice(1), current.tagName.replace(/^v/, "")) > 0;
    } catch (error) {
      if (!/HTTP 404|release not found/i.test(`${error.message}\n${error.stderr || ""}`))
        throw error;
    }
    await run([
      "release",
      "edit",
      tag,
      "--repo",
      repo,
      "--draft=false",
      ...(tag.includes("-") ? ["--prerelease"] : []),
      latest ? "--latest" : "--latest=false",
    ]);
    return { published: true, tag };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url))
  console.log(
    JSON.stringify(
      await publishInstallerRelease({
        directory: path.resolve(process.argv[2] || "release-artifacts"),
        tag: process.argv[3] || process.env.RELEASE_TAG,
      }),
    ),
  );
