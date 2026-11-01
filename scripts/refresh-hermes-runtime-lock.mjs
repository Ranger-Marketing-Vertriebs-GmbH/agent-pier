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

/**
 * Maintainer operation only: moves the Hermes pin (hermes-manifest.json) to another
 * commit, uv or CPython version and records every hash from the bytes it downloaded:
 * the source archive, pyproject.toml and uv.lock inside it, and each uv release
 * archive (checked against the `.sha256` file uv publishes beside it). Product
 * installation only ever consumes the reviewed manifest. See
 * docs/assistant-runtime-updates.md ("Hermes Agent runtime").
 */
export async function refreshHermesRuntimeLock({
  commit = hermesManifest.commit,
  uvVersion = hermesManifest.uvVersion,
  pythonVersion = hermesManifest.pythonVersion,
  extras = hermesManifest.extras,
  output = hermesManifestFile,
  download = (url) => fetchDownload(url, fetch, 512 * 1024 * 1024),
  execute = promisify(execFile),
}) {
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw Error("A full 40-character commit is required.");
  const archiveUrl = `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${commit}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-lock-refresh-"));
  try {
    const archive = await download(archiveUrl);
    const file = path.join(root, "source.tar.gz");
    fs.writeFileSync(file, archive, { mode: 0o600 });
    const prefix = `hermes-agent-${commit}`;
    const members = ["pyproject.toml", "uv.lock", "hermes_cli/__init__.py"];
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
      commit,
      version: commit.slice(0, 12),
      releaseDate,
      archiveUrl,
      archiveSha256: hash(archive),
      pyprojectSha256: hash(pyproject),
      uvLockSha256: hash(read("uv.lock")),
      extras: [...extras],
      pythonVersion,
      uvVersion,
      uvChecksums,
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
    "--commit": "commit",
    "--uv": "uvVersion",
    "--python": "pythonVersion",
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1])
      throw Error(
        "Usage: node scripts/refresh-hermes-runtime-lock.mjs [--commit <sha>] [--uv <version>] [--python <3.14.x>]",
      );
    options[names[args[i]]] = args[i + 1];
  }
  console.log(JSON.stringify(await refreshHermesRuntimeLock(options), null, 2));
}
