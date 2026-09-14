import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const label = "dev.agentpier.server";
export async function inspectSetupService({
  installRoot,
  dataDir,
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  uid = process.getuid?.(),
  run = execute,
  procRoot = "/proc",
}) {
  if (!["darwin", "linux"].includes(platform))
    return { state: "conflict", listener: false };
  const command = async (name, args) => {
    const result = await run(name, args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return typeof result === "string" ? result : result.stdout;
  };
  const launcher = path.join(installRoot, "bin/agentpier");
  const file =
    platform === "darwin"
      ? path.join(home, "Library/LaunchAgents", `${label}.plist`)
      : path.join(
          env.XDG_CONFIG_HOME || path.join(home, ".config"),
          "systemd/user",
          `${label}.service`,
        );
  let configured = false,
    pid = null,
    channel;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      return { state: "conflict", listener: false };
    if (platform === "darwin") {
      const plist = JSON.parse(
        await command("plutil", ["-convert", "json", "-o", "-", file]),
      );
      const vars = plist.EnvironmentVariables || {};
      configured =
        plist.Label === label &&
        plist.ProgramArguments?.length === 1 &&
        plist.ProgramArguments[0] === launcher &&
        vars.AGENTPIER_INSTALL_ROOT === installRoot &&
        vars.AGENTPIER_DATA_DIR === dataDir;
      channel = vars.AGENTPIER_RELEASE_CHANNEL;
    } else {
      const text = fs.readFileSync(file, "utf8");
      const quote = (value) =>
        `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
      configured =
        text.split("\n").includes(`ExecStart=:${quote(launcher)}`) &&
        text
          .split("\n")
          .includes(`Environment=${quote(`AGENTPIER_INSTALL_ROOT=${installRoot}`)}`) &&
        text
          .split("\n")
          .includes(`Environment=${quote(`AGENTPIER_DATA_DIR=${dataDir}`)}`);
      const channelLine = text
        .split("\n")
        .find((line) => line.startsWith('Environment="AGENTPIER_RELEASE_CHANNEL='));
      if (channelLine)
        channel = JSON.parse(channelLine.slice("Environment=".length))
          .slice("AGENTPIER_RELEASE_CHANNEL=".length)
          .replaceAll("%%", "%");
    }
    if (!configured) return { state: "conflict", listener: false };
  } catch (error) {
    if (error.code !== "ENOENT") return { state: "conflict", listener: false };
  }
  try {
    if (platform === "darwin") {
      const loaded = await command("launchctl", ["print", `gui/${uid}/${label}`]);
      if (
        !configured ||
        !loaded.split("\n").some((line) => line.trim() === `program = ${launcher}`) ||
        !loaded
          .split("\n")
          .some((line) => line.trim() === `AGENTPIER_DATA_DIR => ${dataDir}`) ||
        !loaded
          .split("\n")
          .some((line) => line.trim() === `AGENTPIER_INSTALL_ROOT => ${installRoot}`)
      )
        return { state: "conflict", listener: false };
      pid = Number(loaded.match(/\bpid = (\d+)/)?.[1]) || null;
    } else {
      const loaded = await command("systemctl", [
        "--user",
        "show",
        `${label}.service`,
        "--property=MainPID,FragmentPath,ExecStart,Environment",
      ]);
      pid = Number(loaded.match(/^MainPID=(\d+)/m)?.[1]) || null;
      const environment = loaded.match(/^Environment=(.*)$/m)?.[1] || "";
      const variables = (environment.match(/"(?:\\.|[^"\\])*"|[^\s]+/g) || []).map(
        (value) => (value.startsWith('"') ? JSON.parse(value) : value),
      );
      if (
        pid &&
        (!configured ||
          !loaded.includes(`path=${launcher} ;`) ||
          !variables.includes(`AGENTPIER_DATA_DIR=${dataDir}`) ||
          !variables.includes(`AGENTPIER_INSTALL_ROOT=${installRoot}`))
      )
        return { state: "conflict", listener: false };
    }
  } catch (error) {
    // Missing/unloaded jobs return a nonzero status; other failures cannot establish ownership.
    if (!Number.isInteger(error.code) && !Number.isInteger(error.status))
      return { state: "conflict", listener: false };
  }
  let listeners = [];
  try {
    listeners =
      platform === "linux"
        ? linuxListeners(procRoot, pid)
        : (await command("lsof", ["-nP", "-t", "-iTCP:4380", "-sTCP:LISTEN"]))
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
  } catch (error) {
    if (error.code !== 1 && error.status !== 1)
      return { state: "conflict", listener: false };
  }
  if (listeners.some((owner) => owner !== pid) || (listeners.length && !configured))
    return { state: "conflict", listener: true };
  return {
    state: configured ? "matching" : "missing",
    listener: listeners.length > 0,
    pid,
    channel,
  };
}

function linuxListeners(procRoot, pid) {
  const sockets = [];
  for (const family of ["tcp", "tcp6"]) {
    let table;
    try {
      table = fs.readFileSync(path.join(procRoot, "net", family), "utf8");
    } catch (error) {
      if (family === "tcp6" && error.code === "ENOENT") continue;
      throw error;
    }
    for (const row of table.trim().split("\n").slice(1)) {
      const fields = row.trim().split(/\s+/);
      if (fields[1]?.endsWith(":111C") && fields[3] === "0A") sockets.push(fields[9]);
    }
  }
  if (!sockets.length) return [];
  if (!pid) return [-1];
  const directory = path.join(procRoot, String(pid), "fd");
  const owned = new Set(
    fs.readdirSync(directory).map((entry) => {
      try {
        return fs.readlinkSync(path.join(directory, entry));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }),
  );
  return sockets.map((inode) => (owned.has(`socket:[${inode}]`) ? pid : -1));
}
