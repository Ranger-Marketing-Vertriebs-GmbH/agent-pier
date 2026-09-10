import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { projectDir, loadConfig } from "../server/lib/config.js";
import { privateDirectory } from "../server/lib/storage.js";
import { hostEnvironment } from "../server/lib/host-environment.js";
const label = "dev.agentpier.server";
const xml = (v) =>
  String(v).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function renderLaunchAgent({
  projectDir,
  node,
  dataDir,
  envPath,
  launcher,
  installRoot,
  channel,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${launcher ? `<string>${xml(launcher)}</string>` : `<string>${xml(node)}</string><string>${xml(path.join(projectDir, "server/index.js"))}</string>`}</array>
<key>WorkingDirectory</key><string>${xml(projectDir)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string><key>AGENTPIER_DATA_DIR</key><string>${xml(dataDir)}</string>${installRoot ? `<key>AGENTPIER_INSTALL_ROOT</key><string>${xml(installRoot)}</string>` : ""}${channel ? `<key>AGENTPIER_RELEASE_CHANNEL</key><string>${xml(channel)}</string>` : ""}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(path.join(dataDir, "server.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(dataDir, "server-error.log"))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
const unitName = `${label}.service`;
const marker = (project) =>
  `# AgentPier project ${createHash("sha256").update(path.resolve(project)).digest("hex")}`;
function unitValue(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(serverMessages.scripts.invalidSystemdValue);
  return value.replaceAll("%", "%%");
}
const unitQuote = (value) =>
  `"${unitValue(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
export function renderSystemdUnit({
  projectDir,
  node,
  dataDir,
  envPath,
  launcher,
  installRoot,
  channel,
}) {
  for (const value of [projectDir, node, dataDir])
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error(serverMessages.scripts.invalidServicePath);
  // WorkingDirectory takes a raw path, not a quoted argument. Appending /. protects
  // a trailing space or backslash from the unit file's whitespace/continuation syntax.
  // ExecStart's ':' prefix disables $ expansion; %% escapes specifiers in every field.
  return `${marker(projectDir)}
[Unit]
Description=AgentPier web service

[Service]
Type=exec
WorkingDirectory=${unitValue(projectDir)}/.
ExecStart=:${launcher ? unitQuote(launcher) : `${unitQuote(node)} ${unitQuote(path.join(projectDir, "server/index.js"))}`}
Environment=${unitQuote(`PATH=${envPath}`)}
Environment=${unitQuote(`AGENTPIER_DATA_DIR=${dataDir}`)}
${installRoot ? `Environment=${unitQuote(`AGENTPIER_INSTALL_ROOT=${installRoot}`)}\n` : ""}${channel ? `Environment=${unitQuote(`AGENTPIER_RELEASE_CHANNEL=${channel}`)}\n` : ""}\
Restart=always
RestartSec=5
TimeoutStopSec=10
# tmux sessions intentionally outlive the web process.
KillMode=process
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}
function checkFile(file, expected) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(serverMessages.scripts.serviceFileMustBeRegular);
  if (info.size > 1024 * 1024 || !fs.readFileSync(file, "utf8").includes(expected))
    throw new Error(serverMessages.scripts.serviceNameConflict);
}
function writeUnit(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export async function runService({
  action = "status",
  platform = process.platform,
  home = os.homedir(),
  projectDir: project = projectDir,
  node = process.execPath,
  env = process.env,
  config,
  run = execFileSync,
  log = console.log,
  uid = process.getuid?.(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!["install", "status", "stop"].includes(action))
    throw new Error(serverMessages.scripts.serviceUsage);
  if (!["darwin", "linux"].includes(platform))
    throw new Error(serverMessages.scripts.unsupportedServicePlatform);
  const installRoot = env.AGENTPIER_INSTALL_ROOT;
  const launcher = installRoot
    ? path.join(path.resolve(installRoot), "bin/agentpier")
    : undefined;
  const channel = env.AGENTPIER_RELEASE_CHANNEL;
  if (installRoot) {
    if (!path.isAbsolute(installRoot) || !env.AGENTPIER_DATA_DIR)
      throw new Error(
        "Versioned services require absolute install and data directory configuration.",
      );
    project = path.join(installRoot, "current");
    node = path.join(project, "bin/node");
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
    if (!path.isAbsolute(configHome))
      throw new Error(serverMessages.scripts.absoluteXdgConfigRequired);
    const dir = path.join(configHome, "systemd/user"),
      file = path.join(dir, unitName);
    const systemctl = (args) =>
      run("systemctl", ["--user", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    if (action === "status") {
      try {
        log(systemctl(["status", "--no-pager", unitName]));
        return 0;
      } catch (error) {
        log(error.stdout?.toString() || serverMessages.scripts.userServiceUnavailable);
        return 1;
      }
    }
    if (action === "stop") {
      systemctl(["stop", unitName]);
      log(serverMessages.scripts.webServiceStopped);
      return 0;
    }
    if (!fs.existsSync(path.join(project, "dist/index.html")))
      throw new Error(serverMessages.scripts.buildRequired);
    checkFile(file, marker(project));
    config ??= loadConfig();
    const text = renderSystemdUnit({
      projectDir: project,
      node,
      dataDir: config.dataDir,
      envPath: hostEnvironment(env).PATH,
      launcher,
      installRoot,
      channel,
    });
    try {
      systemctl(["show", "--property=Version", "--value"]);
    } catch {
      throw new Error(serverMessages.scripts.systemctlUnavailable);
    }
    privateDirectory(config.dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeUnit(file, text);
    systemctl(["daemon-reload"]);
    systemctl(["enable", unitName]);
    systemctl(["restart", unitName]);
    log(serverMessages.scripts.userServiceConfigured(config.port));
    return 0;
  }
  const target = `gui/${uid}/${label}`;
  const dir = path.join(home, "Library/LaunchAgents");
  const file = path.join(dir, `${label}.plist`);
  if (action === "status") {
    try {
      const output = run("launchctl", ["print", target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      log(
        output
          .split("\n")
          .filter((line) => /state =|pid =|last exit code =|program =/.test(line))
          .join("\n"),
      );
      return 0;
    } catch {
      log(serverMessages.scripts.serviceNotLoaded);
      return 1;
    }
  }
  if (action === "stop") {
    run("launchctl", ["bootout", target], { stdio: "inherit" });
    log(serverMessages.scripts.webServiceStopped);
    return 0;
  }
  config ??= loadConfig();
  privateDirectory(config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  checkFile(file, xml(launcher || path.join(project, "server/index.js")));
  if (!fs.existsSync(path.join(project, "dist/index.html")))
    throw new Error(serverMessages.scripts.buildRequired);
  writeUnit(
    file,
    renderLaunchAgent({
      projectDir: project,
      node,
      dataDir: config.dataDir,
      envPath: hostEnvironment(env).PATH,
      launcher,
      installRoot,
      channel,
    }),
  );
  run("plutil", ["-lint", file], { stdio: "inherit" });
  try {
    run("launchctl", ["bootout", target], { stdio: "ignore" });
  } catch {}
  // launchd may still be tearing down the previous instance after bootout returns.
  for (let attempt = 0; ; attempt++) {
    try {
      run("launchctl", ["bootstrap", `gui/${uid}`, file], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      break;
    } catch (error) {
      if (error.status !== 5 || attempt >= 24) throw error;
      await sleep(250);
    }
  }
  log(serverMessages.scripts.serviceConfigured(config.port));
  return 0;
}
if (isMainModule(import.meta.url))
  try {
    process.exitCode = await runService({
      action: process.argv[2] || "status",
    });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
