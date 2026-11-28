// A stand-in for Google's `emulator` executable (tests/helpers/fake-android-sdk.js
// puts a launcher for it at `<sdk>/emulator/emulator`). It behaves like the real one
// for what AgentPier does with it: it refuses an AVD that is not there, holds its
// console and adb port on loopback, "boots" after a moment, creates files in the AVD
// folder with the process umask, and saves a quick-boot snapshot when the console is
// told to kill it. `<state>/behaviour.json` selects how a launch goes wrong:
//
//   mode "boot"     (default) booted `bootMs` (50) after the launch
//   mode "hang"     never boots
//   mode "die"      exits 1 after `dieMs` (20), before the boot
//   mode "crash"    exits 1 `crashMs` (50) after the boot, without a snapshot
//   mode "stubborn" boots, then ignores the kill request and SIGTERM
//
// It records every launch in `<state>/launches.jsonl` and, while it runs, its state
// in `<state>/emulator-<console port>.json`, which the fake adb reads.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const state = process.env.FAKE_ANDROID_STATE;
const args = process.argv.slice(2);
const stop = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
if (!state) stop("fake emulator: FAKE_ANDROID_STATE is not set", 70);

if (args.includes("-version")) {
  const [version, build] = (process.env.FAKE_ANDROID_EMULATOR || "0.0.0 0").split(" ");
  console.log(`Android emulator version ${version}.0 (build_id ${build}) (CL:N/A)`);
  process.exit(0);
}

const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : (args[index + 1] ?? null);
};
const avd = value("-avd");
const avdHome = process.env.ANDROID_AVD_HOME || "";
const folder = path.join(avdHome, `${avd}.avd`);
const config = (() => {
  try {
    fs.readFileSync(path.join(avdHome, `${avd}.ini`), "utf8");
    return Object.fromEntries(
      fs
        .readFileSync(path.join(folder, "config.ini"), "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
  } catch {
    return null;
  }
})();
if (
  !avd ||
  !avdHome ||
  !config ||
  !["image.sysdir.1", "abi.type", "hw.lcd.width"].every((key) => config[key])
)
  stop(`emulator: ERROR: Unknown AVD name [${avd}], use -list-avds to see valid list.`);
const ports = /^(\d+),(\d+)$/.exec(value("-ports") || "");
if (!ports) stop("emulator: ERROR: the fake emulator needs -ports <console>,<adb>");
if (!process.env.HOME) stop("emulator: ERROR: HOME is not set");
const consolePort = Number(ports[1]),
  adbPort = Number(ports[2]);

const behaviour = readJson(path.join(state, "behaviour.json"), {});
const mode = behaviour.mode || "boot";
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(?:HOME|TMPDIR|PATH|ANDROID_.*|ADB_.*)$/.test(name),
  ),
);
fs.appendFileSync(
  path.join(state, "launches.jsonl"),
  JSON.stringify({
    avd,
    argv: args,
    env: environment,
    pid: process.pid,
    umask: process.umask(),
  }) + "\n",
);

const stateFile = path.join(state, `emulator-${consolePort}.json`);
const snapshot = path.join(folder, "snapshots", "default_boot");
let booted = false;
function killed(socket) {
  if (mode === "stubborn") return socket.end("OK\n");
  // Only a booted device has something to save.
  if (booted) {
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, "snapshot.pb"), "fake snapshot\n");
    console.log("INFO    | Saving snapshot 'default_boot' took 1 ms");
  }
  socket.end("OK: killing emulator, bye bye\nOK\n", () => process.exit(0));
}
const listen = (port, onConnection = (socket) => socket.destroy()) =>
  new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
try {
  await listen(consolePort, (socket) => {
    let text = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      text += chunk;
      if (/^kill\s*$/m.test(text)) killed(socket);
    });
  });
  await listen(adbPort);
} catch (error) {
  stop(`emulator: ERROR: port ${consolePort} or ${adbPort} is in use (${error.code})`);
}

// What the real emulator leaves in the AVD folder and the home on a start; created
// without an explicit mode, so the process umask decides who may read them.
for (const name of ["hardware-qemu.ini", "userdata-qemu.img", "multiinstance.lock"])
  fs.writeFileSync(path.join(folder, name), "fake\n");
fs.writeFileSync(path.join(process.env.HOME, ".emulator_console_auth_token"), "fake\n");

const loaded =
  fs.existsSync(path.join(snapshot, "snapshot.pb")) &&
  !args.includes("-no-snapshot-load");
const bootMs = behaviour.bootMs ?? 50;
const boots = !["hang", "die"].includes(mode);
fs.writeFileSync(
  stateFile,
  JSON.stringify({
    pid: process.pid,
    avd,
    consolePort,
    adbPort,
    mode,
    snapshotLoaded: loaded,
    bootAt: boots ? Date.now() + bootMs : null,
  }),
);
process.on("exit", () => fs.rmSync(stateFile, { force: true }));
if (boots)
  setTimeout(() => {
    booted = true;
    console.log(
      loaded
        ? "INFO    | Successfully loaded snapshot 'default_boot'"
        : "INFO    | Boot completed",
    );
    if (mode === "crash")
      setTimeout(() => stop("emulator: fake crash"), behaviour.crashMs ?? 50);
  }, bootMs);
if (mode === "die")
  setTimeout(
    () => stop("emulator: ERROR: the fake emulator died before the boot"),
    behaviour.dieMs ?? 20,
  );
if (mode === "stubborn")
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
