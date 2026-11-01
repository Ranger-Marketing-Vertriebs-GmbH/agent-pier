import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The pinned Hermes Agent runtime (ADR 0006, decision 4). hermes-manifest.json is
// written by scripts/refresh-hermes-runtime-lock.mjs: a release tag of
// NousResearch/hermes-agent and the commit it names (its source archive and SHA-256), the SHA-256 of the
// pyproject.toml and uv.lock inside it, the extras installed, uv's version with the
// SHA-256 of each release archive, and the CPython version uv installs. uv verifies
// every wheel against the hashes in uv.lock and its managed CPython download against
// the checksums built into the pinned uv release. `agentBrowser` is the agent-browser
// release Hermes's own package lock (pm/lock.json) pins, with its npm archive and
// SHA-256: Hermes's browser tools run it against the Chromium AgentPier starts.
export const hermesManifestFile = fileURLToPath(
  new URL("./hermes-manifest.json", import.meta.url),
);

// uv's release archive names per AgentPier platform (glibc builds on Linux).
export const uvTargets = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
});

const sha256 = /^[0-9a-f]{64}$/;
const exact = /^\d+\.\d+\.\d+$/;
const releaseTag = /^v\d+\.\d+\.\d+$/;

// A release pin names its version after the tag ("v0.22.5" → "0.22.5"); a pin of a
// bare commit after the commit's first 12 characters.
const versionOf = (m) =>
  m.tag === undefined ? m.commit.slice(0, 12) : String(m.tag).slice(1);

/** Throws unless `manifest` is a complete, well-formed Hermes pin; returns it frozen. */
export function validHermesManifest(manifest) {
  const m = manifest || {};
  const archive = `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${m.commit}`;
  if (
    !/^[0-9a-f]{40}$/.test(m.commit || "") ||
    (m.tag !== undefined && !releaseTag.test(m.tag)) ||
    m.version !== versionOf(m) ||
    !/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(m.releaseDate || "") ||
    m.archiveUrl !== archive ||
    ![m.archiveSha256, m.pyprojectSha256, m.uvLockSha256].every((v) => sha256.test(v)) ||
    !Array.isArray(m.extras) ||
    !m.extras.every((extra) => /^[a-z0-9-]+$/.test(extra)) ||
    !/^3\.14\.\d+$/.test(m.pythonVersion || "") ||
    !exact.test(m.uvVersion || "") ||
    Object.keys(m.uvChecksums || {})
      .sort()
      .join() !== Object.keys(uvTargets).sort().join() ||
    !Object.values(m.uvChecksums).every((v) => sha256.test(v)) ||
    !exact.test(m.agentBrowser?.version || "") ||
    m.agentBrowser.url !==
      `https://registry.npmjs.org/agent-browser/-/agent-browser-${m.agentBrowser.version}.tgz` ||
    !sha256.test(m.agentBrowser.sha256 || "")
  )
    throw Error("Invalid Hermes runtime manifest.");
  return Object.freeze({
    ...m,
    extras: Object.freeze([...m.extras]),
    uvChecksums: Object.freeze({ ...m.uvChecksums }),
    agentBrowser: Object.freeze({ ...m.agentBrowser }),
  });
}

export const hermesManifest = validHermesManifest(
  JSON.parse(fs.readFileSync(hermesManifestFile, "utf8")),
);

/** The official uv release archive for `target` ("darwin-arm64", …). */
export const uvArchiveUrl = (manifest, target) =>
  `https://github.com/astral-sh/uv/releases/download/${manifest.uvVersion}/uv-${uvTargets[target]}.tar.gz`;
