// A stand-in for the `adb` executable of the Android platform tools
// (tests/helpers/fake-android-sdk.js puts a launcher for it at
// `<sdk>/platform-tools/adb`). It answers the calls AgentPier makes:
//
//   adb version
//   adb -L tcp:localhost:<port> server nodaemon   the server as a foreground child
//   adb start-server | kill-server
//   adb devices
//   adb -s emulator-<n> shell getprop sys.boot_completed
//   adb -s emulator-<n> emu kill
//   adb -s emulator-<n> shell <command>
//
// Like the real client, a command that needs the server starts a daemonized one when
// none listens on the port; that daemon ignores SIGTERM and ends only on
// `kill-server`. The fake never uses adb's default port 5037: without a private port
// (`-L`, `-P` or ANDROID_ADB_SERVER_PORT) it refuses, so a caller that forgot the
// port fails its test. Every call is appended to `<state>/adb-calls.jsonl` with its
// environment; the devices are the fake emulators' state files in `<state>`.
// `behaviour.json` may hold `shell: { stdout, code, delayMs }` for shell commands.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const state = process.env.FAKE_ANDROID_STATE;
const argv = process.argv.slice(2);
const stop = (message, code = 1) => {
  if (message) console.error(message);
  process.exit(code);
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
if (!state) stop("fake adb: FAKE_ANDROID_STATE is not set", 70);
fs.appendFileSync(
  path.join(state, "adb-calls.jsonl"),
  JSON.stringify({
    argv,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(?:HOME|TMPDIR|PATH|ANDROID_.*|ADB_.*)$/.test(name),
      ),
    ),
    pid: process.pid,
  }) + "\n",
);

const args = [...argv];
let serial = null,
  port = Number(process.env.ANDROID_ADB_SERVER_PORT) || null;
while (["-s", "-L", "-P", "-H"].includes(args[0])) {
  const [flag, value] = args.splice(0, 2);
  if (flag === "-s") serial = value;
  if (flag === "-P") port = Number(value);
  if (flag === "-L") port = Number(/^tcp:(?:[^:]+:)?(\d+)$/.exec(value || "")?.[1]);
}
const [command, ...rest] = args;

if (command === "version") {
  console.log(
    `Android Debug Bridge version 1.0.41\nVersion ${process.env.FAKE_ANDROID_ADB || "0.0.0"}-fake\n` +
      `Installed as ${process.argv[1]}\nRunning on Fake`,
  );
  process.exit(0);
}
if (!Number.isInteger(port) || port === 5037)
  stop("fake adb: refusing to use adb's default server port; a private port is needed");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
// One line to a loopback port and the first line of the answer: null when nothing
// listens there, "" when the listener does not answer.
const ask = (target, word) =>
  new Promise((resolve) => {
    const socket = net.connect(target, "127.0.0.1");
    let text = "",
      connected = false;
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000, () => done(""));
    socket.on("connect", () => {
      connected = true;
      socket.write(`${word}\n`);
    });
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) done(text.split("\n")[0]);
    });
    socket.on("error", () => done(connected ? "" : null));
    socket.on("close", () => done(text.trim()));
  });

const serverModes = ["server", "nodaemon", "fork-server"];
if (serverModes.includes(command)) {
  const daemon = [command, ...rest].includes("fork-server");
  const file = path.join(state, `adb-server-${port}.json`);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const word = String(chunk).trim();
      if (word === "ping") socket.end(`fake-adb ${process.pid}\n`);
      else if (word === "kill") socket.end("OK\n", () => process.exit(0));
      else socket.destroy();
    });
  });
  server.once("error", (error) =>
    stop(
      `adb: error: could not install *smartsocket* listener: cannot bind to 127.0.0.1:${port}: ` +
        `${error.code === "EADDRINUSE" ? "Address already in use" : error.code}`,
    ),
  );
  server.listen(port, "127.0.0.1", () => {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, daemon }));
    process.on("exit", () => {
      if (readJson(file, null)?.pid === process.pid) fs.rmSync(file, { force: true });
    });
    // The daemon a client started ignores SIGTERM, as the real one does on Linux.
    if (daemon) process.on("SIGTERM", () => {});
  });
} else await client();

async function ensureServer() {
  const answer = await ask(port, "ping");
  if (answer?.startsWith("fake-adb ")) return;
  if (answer !== null) stop("adb: protocol fault (couldn't read status): Success");
  console.error(`* daemon not running; starting now at tcp:${port}`);
  spawn(
    process.execPath,
    [process.argv[1], "-L", `tcp:${port}`, "fork-server", "server"],
    {
      detached: true,
      stdio: "ignore",
    },
  ).unref();
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await ask(port, "ping"))?.startsWith("fake-adb ")) {
      console.error("* daemon started successfully");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  stop(`adb: cannot connect to daemon at tcp:${port}: Connection refused`);
}

function emulators() {
  return fs
    .readdirSync(state)
    .map((name) => /^emulator-(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map(([name, consolePort]) => ({
      serial: `emulator-${consolePort}`,
      ...readJson(path.join(state, name), {}),
    }))
    .filter((entry) => entry.pid && alive(entry.pid))
    .map((entry) => ({
      ...entry,
      booted: entry.bootAt !== null && Date.now() >= entry.bootAt,
    }))
    .sort((a, b) => a.consolePort - b.consolePort);
}

async function client() {
  if (command === "kill-server") {
    const answer = await ask(port, "kill");
    if (answer === null)
      stop(`cannot connect to daemon at tcp:${port}: Connection refused`);
    if (answer !== "OK") stop("adb: protocol fault (couldn't read status): Success");
    // The port is free once the server is gone.
    for (let attempt = 0; attempt < 200 && (await ask(port, "ping")) !== null; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    process.exit(0);
  }
  if (command === "start-server") {
    await ensureServer();
    process.exit(0);
  }
  if (!["devices", "shell", "emu"].includes(command))
    stop(`adb: unknown command ${command ?? ""}`.trimEnd());
  await ensureServer();
  const running = emulators();
  if (command === "devices") {
    console.log("List of devices attached");
    for (const device of running)
      console.log(`${device.serial}\t${device.booted ? "device" : "offline"}`);
    console.log("");
    process.exit(0);
  }
  if (!serial && running.length !== 1)
    stop(
      running.length
        ? "adb: more than one device/emulator"
        : "adb: no devices/emulators found",
    );
  const device = serial ? running.find((entry) => entry.serial === serial) : running[0];
  if (!device) stop(`adb: device '${serial}' not found`);
  if (command === "emu") {
    if (rest[0] !== "kill") stop(`adb: unknown emulator command ${rest.join(" ")}`);
    const answer = await ask(device.consolePort, "kill");
    if (answer === null)
      stop(
        `error: could not connect to TCP port ${device.consolePort}: Connection refused`,
      );
    console.log("OK: killing emulator, bye bye\nOK");
    process.exit(0);
  }
  if (rest.join(" ") === "getprop sys.boot_completed") {
    console.log(device.booted ? "1" : "");
    process.exit(0);
  }
  const shell = readJson(path.join(state, "behaviour.json"), {}).shell || {};
  if (shell.delayMs) await new Promise((resolve) => setTimeout(resolve, shell.delayMs));
  process.stdout.write(shell.stdout ?? `${rest.join(" ")}\n`, () =>
    process.exit(shell.code ?? 0),
  );
}
