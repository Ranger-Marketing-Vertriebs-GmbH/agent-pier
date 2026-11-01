import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "../server/lib/is-main-module.js";
import { download as fetchDownload } from "../server/features/operations/releases.js";
import {
  hermesManifest,
  hermesManifestFile,
  uvArchiveUrl,
  uvTargets,
  validHermesManifest,
} from "../server/features/assistants/runtimes/hermes/hermes-manifest.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repository = "https://github.com/NousResearch/hermes-agent";

/**
 * The commit a release tag of Hermes names, from the repository itself
 * (`git ls-remote`): an annotated tag's peeled commit, else the tag's own target.
 */
export async function hermesTagCommit(tag, execute) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || ""))
    throw Error("A release tag such as v0.22.5 is required.");
  const { stdout } = await execute(
    "git",
    ["ls-remote", repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const refs = Object.fromEntries(
    String(stdout)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/).reverse()),
  );
  const commit = refs[`refs/tags/${tag}^{}`] || refs[`refs/tags/${tag}`];
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw Error(`Hermes has no tag ${tag}.`);
  return commit;
}

/**
 * Maintainer operation only: moves the Hermes pin (hermes-manifest.json) to another
 * release tag (or a bare commit), uv or CPython version and records every hash from
 * the bytes it downloaded:
 * the source archive, pyproject.toml and uv.lock inside it, and each uv release
 * archive (checked against the `.sha256` file uv publishes beside it). Product
 * installation only ever consumes the reviewed manifest. See
 * docs/assistant-runtime-updates.md ("Hermes Agent runtime").
 */
export async function refreshHermesRuntimeLock({
  tag = hermesManifest.tag,
  commit,
  uvVersion = hermesManifest.uvVersion,
  pythonVersion = hermesManifest.pythonVersion,
  extras = hermesManifest.extras,
  output = hermesManifestFile,
  download = (url) => fetchDownload(url, fetch, 512 * 1024 * 1024),
  execute = promisify(execFile),
}) {
  // A tag pins the commit it names; a commit given beside it must be that commit.
  if (tag) {
    const tagged = await hermesTagCommit(tag, execute);
    if (commit && commit !== tagged)
      throw Error(`${tag} names ${tagged}, not ${commit}.`);
    commit = tagged;
  }
  commit ??= hermesManifest.commit;
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw Error("A full 40-character commit is required.");
  const archiveUrl = `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${commit}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-lock-refresh-"));
  try {
    const archive = await download(archiveUrl);
    const file = path.join(root, "source.tar.gz");
    fs.writeFileSync(file, archive, { mode: 0o600 });
    const prefix = `hermes-agent-${commit}`;
    const members = [
      "pyproject.toml",
      "uv.lock",
      "hermes_cli/__init__.py",
      "pm/lock.json",
    ];
    await execute(
      "tar",
      ["-xzf", file, "-C", root, ...members.map((name) => `${prefix}/${name}`)],
      { timeout: 300000, maxBuffer: 1024 * 1024 },
    );
    const read = (name) => fs.readFileSync(path.join(root, prefix, name));
    const pyproject = read("pyproject.toml");
    const requires = /requires-python\s*=\s*"([^"]+)"/.exec(String(pyproject))?.[1] || "";
    if (!/<\s*3\.1[5-9]|<\s*4/.test(requires) || !/>=\s*3\.(1[1-4])/.test(requires))
      throw Error(`Hermes ${commit} does not accept Python 3.14 (${requires}).`);
    const releaseDate = /__release_date__\s*=\s*"([^"]+)"/.exec(
      String(read("hermes_cli/__init__.py")),
    )?.[1];
    // The agent-browser release Hermes's own package lock pins, verified here once
    // more: Hermes's browser tools drive AgentPier's Chromium through it.
    const pinned = JSON.parse(String(read("pm/lock.json"))).packages?.["agent-browser"];
    const agentBrowser = {
      version: pinned?.version,
      url: pinned?.artifacts?.any?.url,
      sha256: pinned?.artifacts?.any?.sha256,
    };
    if (hash(await download(agentBrowser.url)) !== agentBrowser.sha256)
      throw Error(`agent-browser ${agentBrowser.version}: checksum mismatch.`);
    const uvChecksums = {};
    for (const target of Object.keys(uvTargets)) {
      const url = uvArchiveUrl({ uvVersion }, target);
      const published = String(await download(`${url}.sha256`))
        .trim()
        .split(/\s+/)[0];
      const actual = hash(await download(url));
      if (published !== actual)
        throw Error(`uv ${uvVersion} ${target}: checksum mismatch.`);
      uvChecksums[target] = actual;
    }
    const manifest = validHermesManifest({
      ...(tag ? { tag } : {}),
      commit,
      version: tag ? tag.slice(1) : commit.slice(0, 12),
      releaseDate,
      archiveUrl,
      archiveSha256: hash(archive),
      pyprojectSha256: hash(pyproject),
      uvLockSha256: hash(read("uv.lock")),
      extras: [...extras],
      pythonVersion,
      uvVersion,
      uvChecksums,
      agentBrowser,
    });
    // Formatted as the repository formats it, so an unchanged pin writes no diff.
    const { format } = await import("prettier");
    fs.writeFileSync(
      output,
      await format(JSON.stringify(manifest), { filepath: hermesManifestFile }),
    );
    return manifest;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const options = {};
  const names = {
    "--tag": "tag",
    "--commit": "commit",
    "--uv": "uvVersion",
    "--python": "pythonVersion",
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1])
      throw Error(
        "Usage: node scripts/refresh-hermes-runtime-lock.mjs [--tag <vX.Y.Z> | --commit <sha>] [--uv <version>] [--python <3.14.x>]",
      );
    options[names[args[i]]] = args[i + 1];
  }
  // A bare commit pin drops the release tag; a tag alone resolves its commit.
  if (options.commit && !options.tag) options.tag = null;
  console.log(JSON.stringify(await refreshHermesRuntimeLock(options), null, 2));
}
