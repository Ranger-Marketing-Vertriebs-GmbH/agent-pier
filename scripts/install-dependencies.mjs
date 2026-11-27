import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostEnvironment } from "../server/lib/host-environment.js";
import {
  parseOpenSshVersion,
  supportsSessionBind,
} from "../server/features/ssh/ssh-openssh-version.js";

const execute = promisify(execFile);
// Package managers need the terminal for sudo passwords and installation progress.
function installCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(Error(`${command} failed. Check the package manager output and retry.`));
    });
  });
}

// Coding sessions reach SSH hosts only through their own SSH agent, which needs the
// session-bind extension OpenSSH clients send since 8.9. There is no fallback.
const packages = {
  darwin: { tmux: "tmux", git: "git", ssh: "openssh" },
  linux: { tmux: "tmux", git: "git", ssh: "openssh-client" },
};
const versionArgs = { tmux: ["-V"], git: ["--version"], ssh: ["-V"] };
// The llama.cpp server behind the agents' semantic memory search (OpenClaw's local
// embeddings, docs/assistant-gateway.md) is built with OpenMP, whose runtime a
// minimal Debian or Ubuntu lacks. It is optional: AgentPier runs without it and the
// setting then names the missing library, so it never fails an installation.
const optionalLibraries = { linux: [{ file: "libgomp.so.1", package: "libgomp1" }] };

/**
 * The packages of optional shared libraries this Linux host lacks, read from the
 * dynamic linker's cache. A listing that cannot be read means unknown: nothing is
 * installed on a guess.
 */
export async function missingLibraryPackages(platform, probe) {
  const libraries = optionalLibraries[platform];
  if (!libraries) return [];
  let listing;
  try {
    listing = String((await probe("ldconfig", ["-p"]))?.stdout ?? "");
  } catch {
    return [];
  }
  if (!/\.so\b/.test(listing)) return [];
  return libraries.filter(({ file }) => !listing.includes(file)).map((l) => l.package);
}

/**
 * `ssh -V` (it prints to stderr): `missing` when it does not run, otherwise the OpenSSH
 * version, or an Error when it is not OpenSSH 8.9 or newer.
 */
export async function checkOpenSsh(probe) {
  let output;
  try {
    output = await probe("ssh", versionArgs.ssh);
  } catch {
    return "missing";
  }
  const text = `${output?.stderr ?? ""}\n${output?.stdout ?? ""}`;
  const version = parseOpenSshVersion(text);
  if (!version)
    return Error(
      "AgentPier needs OpenSSH 8.9 or newer, but ssh -V does not report an OpenSSH version. Install the OpenSSH client and make it the ssh on PATH, then retry.",
    );
  if (!supportsSessionBind(version))
    return Error(
      `AgentPier needs OpenSSH 8.9 or newer; this computer has OpenSSH ${version.major}.${version.minor}. Update the OpenSSH client (for example Ubuntu 22.04 or Debian 12 and newer ship 8.9 or later), then retry.`,
    );
  return version;
}

async function installOptional(libraries, { probe, installRun, uid, interactive, env }) {
  const command = uid === 0 ? "apt-get" : "sudo";
  const prefix = uid === 0 ? [] : [...(interactive ? [] : ["-n"]), "apt-get"];
  try {
    await probe("apt-get", ["--version"]);
    await installRun(command, [...prefix, "install", "-y", ...libraries], {
      env,
      timeout: 600000,
    });
  } catch {
    console.error(
      `Optional: install ${libraries.join(", ")} for the agents' semantic memory search.`,
    );
  }
}

export async function ensureDependencies({
  install = true,
  platform = process.platform,
  run = execute,
  installRun = run === execute ? installCommand : run,
  env = process.env,
  uid = process.getuid?.(),
  interactive = Boolean(process.stdin.isTTY),
} = {}) {
  const runtimeEnv = hostEnvironment(env);
  const probe = (command, args) => run(command, args, { env: runtimeEnv, timeout: 3000 });
  const missing = [];
  for (const tool of ["tmux", "git"]) {
    try {
      await probe(tool, versionArgs[tool]);
    } catch {
      missing.push(tool);
    }
  }
  // An old OpenSSH is refused before anything is installed: no package manager
  // step here replaces the distribution's client.
  const openssh = await checkOpenSsh(probe);
  if (openssh instanceof Error) throw openssh;
  if (openssh === "missing") missing.push("ssh");
  const libraries = await missingLibraryPackages(platform, probe);
  if (!missing.length) {
    // Only an optional library is missing: installed when packages may be installed
    // and apt-get is there; a refusal (no sudo) is no error.
    if (install && libraries.length)
      await installOptional(libraries, {
        probe,
        installRun,
        uid,
        interactive,
        env: runtimeEnv,
      });
    return { installed: [], env: runtimeEnv };
  }
  const names = (platformPackages) =>
    missing.map((tool) => platformPackages?.[tool] ?? tool);
  if (!install)
    throw Error(
      `Missing ${missing.join(", ")}. Re-run with --install-dependencies or --dependencies-only to install host prerequisites.`,
    );
  const options = { env: runtimeEnv, timeout: 600000 };
  if (platform === "darwin") {
    try {
      await probe("brew", ["--version"]);
    } catch {
      await installRun(
        "/bin/sh",
        [fileURLToPath(new URL("./install-homebrew.sh", import.meta.url))],
        {
          env: runtimeEnv,
          timeout: 1800000,
        },
      );
      try {
        await probe("brew", ["--version"]);
      } catch {
        throw Error(
          "Homebrew is still unavailable after installation. Check its installer output and administrator access, then retry.",
        );
      }
    }
    await installRun("brew", ["install", ...names(packages.darwin)], options);
  } else if (platform === "linux") {
    try {
      await probe("apt-get", ["--version"]);
    } catch {
      throw Error(
        `Missing ${missing.join(", ")}. Automatic Linux setup requires apt-get. Install these tools with your package manager, then re-run the installer.`,
      );
    }
    const command = uid === 0 ? "apt-get" : "sudo";
    const prefix = uid === 0 ? [] : [...(interactive ? [] : ["-n"]), "apt-get"];
    try {
      await installRun(command, [...prefix, "update"], options);
      await installRun(
        command,
        [...prefix, "install", "-y", ...names(packages.linux), ...libraries],
        options,
      );
    } catch {
      throw Error(
        `Could not install ${missing.join(", ")}. Run the installer in a terminal with sudo access, or install these packages as an administrator and retry.`,
      );
    }
  } else {
    throw Error(
      "Automatic dependency setup supports macOS/Homebrew and Linux/apt. Install tmux, Git and OpenSSH 8.9 or newer with your platform package manager.",
    );
  }
  for (const tool of missing) {
    if (tool === "ssh") {
      const installed = await checkOpenSsh(probe);
      if (installed instanceof Error) throw installed;
      if (installed !== "missing") continue;
      throw Error(
        "ssh is still unavailable after installation. Check the OpenSSH client installation and PATH before starting AgentPier.",
      );
    }
    try {
      await probe(tool, versionArgs[tool]);
    } catch {
      throw Error(
        `${tool} is still unavailable after installation. Check its installation and PATH before starting AgentPier.`,
      );
    }
  }
  return { installed: missing, env: runtimeEnv };
}
