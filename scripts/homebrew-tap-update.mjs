import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderInstallerFormula } from "./homebrew-formula.mjs";
import { isMainModule } from "../server/lib/is-main-module.js";
import { compareReleaseVersions } from "../server/features/operations/version.js";
import { installerVersion } from "./installer-package.mjs";
const execute = promisify(execFile);
const repository = "Ranger-Marketing-Vertriebs-GmbH/homebrew-tap";

export async function updateHomebrewTap({ tapDirectory, metadata, run = execute }) {
  const formula = renderInstallerFormula({
    version: metadata.version,
    ...metadata.bundle,
  });
  if (metadata.version.includes("-")) return { proposed: false, reason: "prerelease" };
  const branch = `chore/agentpier-installer-${metadata.version}`;
  const git = async (...args) =>
    (await run("git", args, { cwd: tapDirectory })).stdout.trim();
  if (await git("status", "--porcelain"))
    throw Error("Tap checkout must be clean before proposing an update.");
  const prs = JSON.parse(
    (
      await run("gh", [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "url,state",
      ])
    ).stdout,
  );
  const existing = prs.find((pr) => pr.state === "OPEN" || pr.state === "MERGED");
  if (existing) return { proposed: false, url: existing.url };
  if (prs.length)
    throw Error("This installer update PR was closed; inspect it before retrying.");
  const formulaPath = path.join(tapDirectory, "Formula/agentpier-installer.rb");
  let current;
  try {
    const source = await fs.readFile(formulaPath, "utf8");
    const explicitVersion = source.match(/^\s*version "([^"]+)"\s*$/m)?.[1];
    const releaseUrl = source.match(/^\s*url "([^"]+)"\s*$/m)?.[1];
    current = installerVersion(
      explicitVersion ?? releaseUrl?.match(/\/releases\/download\/v([^/]+)\//)?.[1],
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current && compareReleaseVersions(metadata.version, current) <= 0)
    return { proposed: false, reason: "not-newer" };
  const remote = await git("ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  if (remote) {
    await git("fetch", "origin", `refs/heads/${branch}`);
    await git("switch", "-c", branch, "FETCH_HEAD");
  } else await git("switch", "-c", branch);
  await fs.mkdir(path.join(tapDirectory, "Formula"), { recursive: true });
  await fs.writeFile(path.join(tapDirectory, "Formula/agentpier-installer.rb"), formula);
  await fs.chmod(path.join(tapDirectory, "Formula/agentpier-installer.rb"), 0o644);
  await git("add", "Formula/agentpier-installer.rb");
  if (await git("diff", "--cached", "--name-only"))
    await git("commit", "-m", `chore: update AgentPier installer to ${metadata.version}`);
  await git("push", "origin", `HEAD:refs/heads/${branch}`);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-tap-pr-"));
  try {
    const body = path.join(temporary, "body.md");
    await fs.writeFile(
      body,
      `Install the verified AgentPier ${metadata.version} setup bundle. Application updates remain managed by AgentPier.\n\nSource release: https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/tag/v${metadata.version}\n\nValidation: source release assets were verified before publication. Tap CI must pass formula audit and installation tests on both macOS architectures before merge.\n`,
    );
    const result = await run("gh", [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `chore: update AgentPier installer to ${metadata.version}`,
      "--body-file",
      body,
    ]);
    return { proposed: true, url: result.stdout.trim() };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url))
  console.log(
    JSON.stringify(
      await updateHomebrewTap({
        tapDirectory: path.resolve(process.argv[2]),
        metadata: JSON.parse(await fs.readFile(path.resolve(process.argv[3]), "utf8")),
      }),
    ),
  );
