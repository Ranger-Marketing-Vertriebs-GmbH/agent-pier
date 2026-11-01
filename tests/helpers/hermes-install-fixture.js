import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  hermesManifest,
  uvArchiveUrl,
  uvTargets,
  validHermesManifest,
} from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

function tarball(root, name, files) {
  const folder = path.join(root, "build", name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), content, { mode: 0o755 });
  }
  const archive = path.join(root, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", path.dirname(folder), name]);
  return fs.readFileSync(archive);
}

/**
 * A disposable data directory and a Hermes manifest whose source and uv archives are
 * tiny local tarballs; `download` serves them by URL and `execute` stands in for uv
 * and the installed Python (tar runs for real). `calls` records each command with
 * its environment; `tamper` changes what a download returns.
 */
export function hermesInstallFixture(
  t,
  { releaseDate = "2026.9.24", commit = "b".repeat(40) } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const pyproject = 'requires-python = ">=3.11,<3.15"\n';
  const lock = "version = 1\n";
  const source = tarball(root, `hermes-agent-${commit}`, {
    "pyproject.toml": pyproject,
    "uv.lock": lock,
    "hermes_cli/__init__.py": `__release_date__ = "${releaseDate}"\n`,
  });
  const uv = tarball(root, "uv-fake", { uv: "#!/bin/sh\n", uvx: "#!/bin/sh\n" });
  // agent-browser's npm archive: one binary per platform below package/bin/.
  const agentBrowser = tarball(root, "package", {
    "bin/agent-browser-linux-x64": "#!/bin/sh\necho agent-browser\n",
    "bin/agent-browser-darwin-arm64": "#!/bin/sh\necho agent-browser\n",
  });
  // A pin of a bare commit: the shipped release tag names another one.
  const { tag: _tag, ...shipped } = hermesManifest;
  const manifest = validHermesManifest({
    ...shipped,
    commit,
    version: commit.slice(0, 12),
    releaseDate,
    archiveUrl: `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${commit}`,
    archiveSha256: sha(source),
    pyprojectSha256: sha(Buffer.from(pyproject)),
    uvLockSha256: sha(Buffer.from(lock)),
    uvChecksums: Object.fromEntries(Object.keys(uvTargets).map((key) => [key, sha(uv)])),
    agentBrowser: { ...shipped.agentBrowser, sha256: sha(agentBrowser) },
  });
  const files = new Map([
    [manifest.archiveUrl, source],
    [manifest.agentBrowser.url, agentBrowser],
  ]);
  for (const target of Object.keys(uvTargets))
    files.set(uvArchiveUrl(manifest, target), uv);
  const tampered = new Map();
  const calls = [];
  const fixture = {
    root,
    dataDir,
    manifest,
    calls,
    tamper: (url, bytes) => tampered.set(url, bytes),
    download: async (url) => {
      calls.push({ download: url });
      if (tampered.has(url)) return tampered.get(url);
      if (!files.has(url)) throw Error(`unexpected download ${url}`);
      return files.get(url);
    },
    probe: { releaseDate, python: manifest.pythonVersion },
    async execute(file, args, options) {
      calls.push({ file, args, env: options.env, cwd: options.cwd });
      if (file === "tar") return run(file, args, options);
      if (file.endsWith("/uv/uv")) {
        if (args[0] === "--version") return { stdout: `uv ${manifest.uvVersion}\n` };
        if (args[0] === "sync") {
          const bin = path.join(options.env.UV_PROJECT_ENVIRONMENT, "bin");
          fs.mkdirSync(bin, { recursive: true });
          for (const name of ["python", "hermes"])
            fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
        }
        return { stdout: "" };
      }
      if (file.endsWith("/venv/bin/python"))
        return { stdout: `${JSON.stringify(fixture.probe)}\n` };
      if (file.endsWith("/venv/bin/hermes")) return { stdout: "Hermes Agent\n" };
      throw Error(`unexpected command ${file}`);
    },
  };
  fixture.options = {
    dataDir,
    manifest,
    download: fixture.download,
    execute: (...args) => fixture.execute(...args),
    platform: "linux",
    arch: "x64",
    environment: {
      HOME: os.homedir(),
      HTTPS_PROXY: "http://proxy.test:3128",
      SECRET: "x",
    },
  };
  return fixture;
}
