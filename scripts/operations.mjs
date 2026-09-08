import { isMainModule } from "../server/lib/is-main-module.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/lib/config.js";
import { Doctor } from "../server/features/operations/doctor.js";
import { Backup } from "../server/features/operations/backup.js";
import { Restore } from "../server/features/operations/restore.js";
import { Releases } from "../server/features/operations/releases.js";
import {
  activateRelease,
  installLauncher,
  switchRelease,
} from "../server/features/operations/release-activation.js";
import { readJson } from "../server/features/operations/files.js";
export async function runOperations(
  args,
  { config = loadConfig(), stdin = process.stdin, log = console.log } = {},
) {
  const [action, ...rest] = args,
    options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (
      ![
        "--archive",
        "--target",
        "--project-map",
        "--version",
        "--staged-id",
        "--install-root",
        "--channel",
        "--passphrase-stdin",
        "--with-credentials",
        "--no-history",
        "--deep",
      ].includes(key)
    )
      throw Error("Unknown operation option.");
    if (
      ["--passphrase-stdin", "--with-credentials", "--no-history", "--deep"].includes(key)
    )
      options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--"))
        throw Error("Operation option requires a value.");
      options[key] = rest[++i];
    }
  }
  let passphrase;
  if (options["--passphrase-stdin"]) {
    let text = "";
    for await (const chunk of stdin) {
      text += chunk;
      if (text.length > 4097) throw Error("Passphrase exceeds its limit.");
    }
    passphrase = text.replace(/\r?\n$/, "");
  }
  let result;
  if (action === "doctor")
    result = await new Doctor(config).run({ deep: options["--deep"] === true });
  else if (action === "backup")
    result = await new Backup(config).create({
      withCredentials: options["--with-credentials"] === true,
      includeHistory: !options["--no-history"],
      passphrase,
    });
  else if (["inspect", "restore"].includes(action)) {
    const input = {
      archive: options["--archive"],
      targetDataDir: options["--target"],
      projectMap: options["--project-map"] ? readJson(options["--project-map"]) : {},
      passphrase,
    };
    result = await new Restore(config)[action === "inspect" ? "inspect" : "apply"](input);
  } else if (
    [
      "release-status",
      "release-check",
      "release-stage",
      "release-activate",
      "release-rollback",
      "release-install",
    ].includes(action)
  ) {
    const installRoot = options["--install-root"] || process.env.AGENTPIER_INSTALL_ROOT;
    const releases = new Releases({
      ...config,
      installRoot,
      channel: options["--channel"] || process.env.AGENTPIER_RELEASE_CHANNEL,
    });
    if (action === "release-status") result = releases.status();
    else if (action === "release-check") result = await releases.check();
    else if (action === "release-stage")
      result = await releases.stage({
        version: options["--version"],
        archive: options["--archive"],
      });
    else if (action === "release-install") {
      if (fs.existsSync(path.join(installRoot, "current")))
        throw Error("An installation already exists; use release-activate.");
      const staged = await releases.stage({
        version: options["--version"],
        archive: options["--archive"],
      });
      const launcher = installLauncher({ installRoot, dataDir: config.dataDir });
      switchRelease(installRoot, staged.version);
      result = { ...staged, launcher, serviceInstalled: false };
    } else
      result = await activateRelease({
        installRoot,
        dataDir: config.dataDir,
        port: config.port,
        stagedId: options["--staged-id"],
        version: options["--version"],
      });
  } else
    throw Error(
      "Use doctor, backup, inspect, restore, release-status, release-check, release-stage, release-install, release-activate or release-rollback.",
    );
  log(JSON.stringify(result, null, 2));
  return result;
}
if (isMainModule(import.meta.url)) {
  try {
    const result = await runOperations(process.argv.slice(2));
    if (
      process.argv[2] === "doctor" &&
      result.checks.some((check) => check.status === "fail")
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(
      error.status
        ? error.message
        : "Operation failed. Check the supplied paths, options and runtime prerequisites.",
    );
    process.exitCode = 1;
  }
}
