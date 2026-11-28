import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import yazl from "yazl";
import { processIdentity } from "../../server/lib/process-identity.js";
import { run as runTool } from "../../server/features/tools/tool-run.js";
import {
  devicePaths,
  ensureDeviceFolders,
  receiptFile,
} from "../../server/features/devices/device-paths.js";

/*
 * A fake Android SDK for tests: archives whose `emulator` and `adb` are launchers
 * for tests/fixtures/fake-emulator.mjs and fake-adb.mjs, a manifest pinned to those
 * archives, and a download host that serves them. Nothing here starts a real
 * emulator or adb, reaches the network, or touches `~/.android` or port 5037.
 *
 * The fakes are Node scripts, so the executable of a running fake is the node
 * binary; `identity(pid)` reports the launcher below the SDK instead, as
 * processIdentity does for the real, native executables.
 */
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const repository = "https://dl.google.com/android/repository/";
const hosts = {
  "linux-x64": { platform: "linux", arch: "x64", abi: "x86_64" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", abi: "arm64-v8a" },
};
// The libraries the fake emulator archive brings in `lib64`.
export const bundledLibraries = ["libfake.so", "libc++.so", "libandroid-emu-base.so"];

/**
 * What `ldd <binary>` prints for a file of the fake Linux emulator, as the real one
 * answers. The launcher needs only the host's libc. A headless qemu binary needs the
 * emulator's bundled libraries, which resolve only from a folder on
 * `env.LD_LIBRARY_PATH` (the real launcher sets it to `<emulator>/lib64`): without
 * it each reads "not found" although the emulator runs. A binary that emulates
 * another architecture names a library no host has.
 */
export function fakeLdd(binary, env = {}) {
  const lines = ["\tlinux-vdso.so.1 (0x00007ffc0000)"];
  if (binary.endsWith("-headless")) {
    const folders = String(env.LD_LIBRARY_PATH || "")
      .split(":")
      .filter(Boolean);
    for (const name of bundledLibraries) {
      const folder = folders.find((entry) => fs.existsSync(path.join(entry, name)));
      lines.push(
        folder
          ? `\t${name} => ${path.join(folder, name)} (0x00007f0000001000)`
          : `\t${name} => not found`,
      );
    }
    if (path.basename(path.dirname(binary)) !== "linux-x86_64")
      lines.push("\tlibfake-foreign.so.1 => not found");
  }
  lines.push("\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)");
  return lines.join("\n") + "\n";
}

// What installFakeSdk needs to know about a manifest made here.
const made = new WeakMap();

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Resolves once `check()` answers truthy; it waits on state, not on a duration. */
export async function waitUntil(
  check,
  { everyMs = 10, describe = "the condition" } = {},
) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw Error(`Gave up waiting for ${describe}.`);
}

/**
 * Where the device tests take their loopback ports: below the ports the system hands
 * out by itself (Linux from 32768, macOS from 49152), and clear of AgentPier's device
 * ports (47600 to 47621), adb's default port and emulator scan range (5037, 5555 to
 * 5585), the preview ranges of tests/helpers/preview-ports.js (22000 to 32000) and
 * the pipeline ports (20100 to 20999). Every test process has one slot of `slot`
 * ports to itself, enough for the largest test file several times over.
 */
export const devicePortRange = Object.freeze({ first: 10240, slot: 128, slots: 60 });
const listen = (port, keep) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen(port, "127.0.0.1", () =>
      keep ? resolve(probe) : probe.close(() => resolve(probe)),
    );
  });
const bindable = async (port) => !!(await listen(port, false));
// The slot of this process. Its first port stays bound as long as the process lives:
// a bind is the one claim two test processes cannot both win, whatever their pids.
let claim = null;
async function claimSlot() {
  const { first, slot, slots } = devicePortRange;
  for (let step = 0; step < slots; step++) {
    const base = first + ((process.pid + step) % slots) * slot;
    const holder = await listen(base, true);
    if (!holder) continue;
    holder.unref();
    return { base, next: 2 };
  }
  throw Error("Every slot of device test ports is taken.");
}

/**
 * Loopback ports for one test, all free now: `adbPort` for the adb server and
 * `pairs` console ports from `first` to `last` (even steps; a device's adb port is
 * its console port plus one), as `consolePorts` of EmulatorSource. They come from
 * this process's own slot of devicePortRange, which is used again from its start
 * once it is through, and each is bound once to prove that it is free.
 */
export async function freeDevicePorts(pairs = 1) {
  claim ??= claimSlot();
  const slot = await claim;
  const width = 2 + pairs * 2;
  const { slot: size } = devicePortRange;
  if (width > size - 2) throw RangeError("Too many device ports for one test.");
  for (let attempt = 0; attempt < size; attempt++) {
    if (slot.next + width > size) slot.next = 2;
    const adbPort = slot.base + slot.next;
    slot.next += width;
    const wanted = Array.from({ length: 1 + pairs * 2 }, (_, index) =>
      index ? adbPort + 1 + index : adbPort,
    );
    if ((await Promise.all(wanted.map(bindable))).every(Boolean))
      return {
        adbPort,
        consolePorts: { first: adbPort + 2, last: adbPort + pairs * 2 },
      };
  }
  throw Error("No free device test ports in this process's slot.");
}

// A launcher: the fixture runs with the state folder and the version it reports.
function launcher(fixture, state, variables) {
  // A shebang line is limited (127 bytes on older Linux kernels) and takes one word.
  const node =
    process.execPath.length <= 100 && !/\s/.test(process.execPath)
      ? process.execPath
      : "/usr/bin/env node";
  const env = { FAKE_ANDROID_STATE: state, ...variables };
  return (
    `#!${node}\n// A fake for tests (tests/helpers/fake-android-sdk.js).\n` +
    Object.entries(env)
      .map(([name, value]) => `process.env.${name} = ${JSON.stringify(value)};\n`)
      .join("") +
    `import(${JSON.stringify(pathToFileURL(path.join(fixtures, fixture)).href)}).catch(` +
    `(error) => {\n  console.error(error);\n  process.exit(70);\n});\n`
  );
}

function zip(files) {
  return new Promise((resolve) => {
    const archive = new yazl.ZipFile();
    for (const { name, content, mode } of files)
      archive.addBuffer(Buffer.from(content), name, {
        mode: 0o100000 | mode,
        // A fixed time: the same files are the same archive, whenever it is built.
        mtime: new Date(Date.UTC(2026, 0, 1)),
      });
    const chunks = [];
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.end();
  });
}

// A download host for the archives in `served` (url -> bytes). It honours a range
// request and can be told to misbehave; a rule stays until `reset()` and applies to
// every address, or only to those containing `only`.
function downloadHost(served) {
  let rules = [];
  const requests = [];
  const rule = (kind, url) =>
    rules.find((entry) => entry.kind === kind && url.includes(entry.only));
  const fetchImpl = async (url, { headers = {}, signal } = {}) => {
    const range = headers.range ?? headers.Range ?? null;
    requests.push({ url, range });
    signal?.throwIfAborted();
    const refused = rule("status", url);
    if (refused) return new Response("no", { status: refused.value });
    let content = served.get(url);
    if (!content) return new Response("not found", { status: 404 });
    if (rule("corrupt", url)) {
      content = Buffer.from(content);
      content[content.length >> 1] ^= 0xff;
    }
    const from = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
    if (range && from >= content.length)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${content.length}` },
      });
    const rest = content.subarray(from);
    const broken = rule("failAfter", url);
    const stalled = rule("stall", url);
    // What is delivered before the transfer breaks off or stalls: everything else.
    const limit = broken?.value ?? stalled?.value ?? rest.length;
    const sent = rest.subarray(0, limit);
    let at = 0;
    const body = new ReadableStream({
      start(controller) {
        const fail = () => controller.error(signal.reason);
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      },
      // One chunk per read, so the bytes before a break reach the reader.
      pull(controller) {
        if (at < sent.length) {
          controller.enqueue(sent.subarray(at, at + 16384));
          at += 16384;
        } else if (broken && sent.length < rest.length)
          controller.error(Object.assign(Error("terminated"), { code: "ECONNRESET" }));
        // A stalled transfer delivers nothing more and never ends by itself.
        else if (stalled) return new Promise(() => {});
        else controller.close();
      },
    });
    return new Response(body, {
      status: range ? 206 : 200,
      headers: range
        ? { "content-range": `bytes ${from}-${content.length - 1}/${content.length}` }
        : {},
    });
  };
  const add =
    (kind) =>
    (value, only = "") => {
      rules.push({ kind, value, only });
      return fetchImpl;
    };
  return Object.assign(fetchImpl, {
    requests,
    /** Every transfer breaks off after `bytes` bytes of its body. */
    failAfter: add("failAfter"),
    /** Every transfer answers and then delivers nothing: `stall(only)`. */
    stall: (only = "") => add("stall")(0, only),
    /** Every transfer delivers `bytes` bytes and then nothing more. */
    stallAfter: add("stall"),
    /** One byte of every served archive is wrong: `corrupt(only)`. */
    corrupt: (only = "") => add("corrupt")(true, only),
    /** Every request is answered with HTTP status `code`. */
    status: add("status"),
    reset: () => {
      rules = [];
      return fetchImpl;
    },
  });
}

/**
 * A disposable fake SDK below `root` (a fresh temporary folder by default):
 *
 * - `dataDir`, `paths` (devicePaths for `platform`), `host`, `key`, `state`
 * - `manifest`: the androidManifest shape, pinned to the fake archives
 * - `pin({ emulator, build, platformTools, image: { api, revision } })`: another
 *   manifest (a later release's pin), served by the same host
 * - `fetchImpl`: the download host; `.requests`, `.failAfter(bytes, only)`,
 *   `.stall(only)`, `.stallAfter(bytes, only)`, `.corrupt(only)`,
 *   `.status(code, only)`, `.reset()`
 * - `behaviour(patch)`: merges into `<state>/behaviour.json`, read by both fakes
 * - `calls()`: the fake adb's calls, `[{ argv, env, pid, umask }]`
 * - `launches()`: the fake emulator's launches, `[{ avd, argv, env, pid, umask }]`
 * - `emulators()`, `servers()`: the fake emulators and adb servers alive now
 * - `pids()`: every pid a fake recorded; `identity(pid)`: see above
 * - `cleanup()`: kills what the fakes left running, removes the folders and resolves
 *   every pid a fake recorded, so a test can assert that none is alive
 */
export async function fakeAndroidSdk({ root, platform = "linux-x64" } = {}) {
  if (!hosts[platform]) throw Error(`Unknown platform ${platform}.`);
  const own = !root;
  const base = fs.realpathSync(
    root || fs.mkdtempSync(path.join(os.tmpdir(), "fake-android-sdk-")),
  );
  const dataDir = path.join(base, "data");
  const state = path.join(base, "state");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const served = new Map();
  const fetchImpl = downloadHost(served);

  async function pin({
    emulator = "37.3.10",
    build = "16970787",
    platformTools = "37.0.3",
    image = {},
  } = {}) {
    const { api = 36, revision = 7 } = image;
    const id = `android-${api}-google_apis-r${revision}`;
    const contents = new Map();
    const archive = async (url, top, files) => {
      const entries = files.map((file) => ({ ...file, name: `${top}/${file.name}` }));
      const bytes = await zip(entries);
      served.set(url, bytes);
      contents.set(url, files);
      return {
        url,
        sha256: sha256(bytes),
        size: bytes.length,
        top,
        files: files.length,
        expandedBytes: files.reduce(
          (sum, file) => sum + Buffer.byteLength(file.content),
          0,
        ),
      };
    };
    const properties = (revisionText) => ({
      name: "source.properties",
      content: `Pkg.Revision=${revisionText}\n`,
      mode: 0o644,
    });
    const manifest = {
      baseUrl: repository,
      hosts: ["dl.google.com"],
      emulator: { version: emulator, build, archives: {} },
      platformTools: { version: platformTools, archives: {} },
      image: { id, api, tag: "google_apis", revision, archives: {} },
      shape: {
        width: 720,
        height: 1600,
        density: 320,
        cores: 4,
        memoryMb: 2048,
        dataPartition: "6G",
      },
      licences: [
        {
          id: "android-sdk-license",
          name: "Android Software Development Kit License Agreement",
          url: "https://developer.android.com/studio/terms",
        },
      ],
    };
    for (const [key, { abi }] of Object.entries(hosts)) {
      manifest.emulator.archives[key] = await archive(
        `${repository}emulator-${key}-${build}.zip`,
        "emulator",
        [
          {
            name: "emulator",
            content: launcher("fake-emulator.mjs", state, {
              FAKE_ANDROID_EMULATOR: `${emulator} ${build}`,
              FAKE_ANDROID_PLATFORM: key,
            }),
            mode: 0o755,
          },
          // The emulator's own libraries, which its binaries load from here.
          ...bundledLibraries.map((name) => ({
            name: `lib64/${name}`,
            content: `library for ${key}\n`,
            mode: 0o644,
          })),
          // The binary that runs a device without a window, as in the real archive,
          // beside one that emulates another architecture and never runs.
          ...(key === "linux-x64"
            ? [
                "linux-x86_64/qemu-system-x86_64",
                "linux-aarch64/qemu-system-aarch64",
              ].map((name) => ({
                name: `qemu/${name}-headless`,
                content: "headless qemu\n",
                mode: 0o755,
              }))
            : []),
          properties(emulator),
        ],
      );
      manifest.platformTools.archives[key] = await archive(
        `${repository}platform-tools_r${platformTools}-${key}.zip`,
        "platform-tools",
        [
          {
            name: "adb",
            content: launcher("fake-adb.mjs", state, { FAKE_ANDROID_ADB: platformTools }),
            mode: 0o755,
          },
          properties(platformTools),
        ],
      );
      manifest.image.archives[key] = {
        ...(await archive(
          `${repository}sys-img/google_apis/${abi}-${api}_r0${revision}.zip`,
          abi,
          [
            { name: "system.img", content: `system image ${id} ${abi}\n`, mode: 0o644 },
            { name: "data/misc/placeholder", content: "data\n", mode: 0o644 },
            properties(revision),
          ],
        )),
        abi,
      };
    }
    made.set(manifest, { contents, platform });
    return manifest;
  }

  const manifest = await pin();
  const { abi: _abi, ...host } = hosts[platform];
  const paths = devicePaths(dataDir, manifest, host);
  const behaviourFile = path.join(state, "behaviour.json");
  const lines = (name) => {
    try {
      return fs
        .readFileSync(path.join(state, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const records = (pattern) =>
    (fs.existsSync(state) ? fs.readdirSync(state) : [])
      .filter((name) => pattern.test(name))
      .flatMap((name) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(state, name), "utf8"))];
        } catch {
          return [];
        }
      });
  const live = (pattern) => records(pattern).filter((entry) => alive(entry.pid));
  const pids = () => [
    ...new Set(
      [
        ...lines("launches.jsonl"),
        ...lines("adb-calls.jsonl"),
        ...records(/^(?:emulator|adb-server)-\d+\.json$/),
      ].map((entry) => entry.pid),
    ),
  ];
  // Only a process whose command line names this fake SDK is one of ours.
  const ours = (pid) => {
    try {
      return alive(pid) && processIdentity(pid).command.includes(base);
    } catch {
      return false;
    }
  };

  return {
    root: base,
    dataDir,
    paths,
    host,
    key: platform,
    manifest,
    pin,
    fetchImpl,
    state,
    /**
     * The installer's process runner on this fake host: `ldd` answers as on a Linux
     * host (fakeLdd; a Mac has none), everything else really runs.
     */
    run(command, args, env, ...rest) {
      if (command !== "ldd") return runTool(command, args, env, ...rest);
      return platform.startsWith("linux")
        ? Promise.resolve(fakeLdd(args[0], env))
        : Promise.reject(Error("ldd: command not found"));
    },
    behaviour(patch) {
      let current = {};
      try {
        current = JSON.parse(fs.readFileSync(behaviourFile, "utf8"));
      } catch {
        // No behaviour yet.
      }
      const next = { ...current, ...patch };
      fs.writeFileSync(behaviourFile, JSON.stringify(next));
      return next;
    },
    calls: () => lines("adb-calls.jsonl"),
    launches: () => lines("launches.jsonl"),
    emulators: () =>
      live(/^emulator-\d+\.json$/).map((entry) => ({
        serial: `emulator-${entry.consolePort}`,
        ...entry,
      })),
    servers: () => live(/^adb-server-\d+\.json$/),
    pids,
    identity(pid) {
      const real = processIdentity(pid);
      const script = [paths.emulatorBin, paths.adbBin].find((file) =>
        real.command.split(" ").includes(file),
      );
      return script ? { ...real, executable: fs.realpathSync(script) } : real;
    },
    async cleanup() {
      const recorded = pids();
      const left = recorded.filter(ours);
      for (const pid of left)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone in the meantime.
        }
      await waitUntil(() => left.every((pid) => !alive(pid)), {
        describe: "the fake processes to end",
      });
      for (const folder of own ? [base] : [dataDir, state])
        fs.rmSync(folder, { recursive: true, force: true });
      return recorded;
    },
  };
}

/**
 * Puts the unpacked SDK of `manifest` (one made by fakeAndroidSdk or its `pin`) below
 * `dataDir` with its receipts, as a finished installation leaves it, without a
 * download. `platform` defaults to the fake SDK's own.
 */
export async function installFakeSdk(dataDir, manifest, { platform } = {}) {
  const known = made.get(manifest);
  if (!known) throw Error("installFakeSdk needs a manifest made by fakeAndroidSdk.");
  const key = platform || known.platform;
  const { abi: _abi, ...host } = hosts[key];
  const paths = ensureDeviceFolders(devicePaths(dataDir, manifest, host));
  for (const [name, directory, version] of [
    ["platformTools", paths.platformTools, manifest.platformTools.version],
    ["emulator", paths.emulator, manifest.emulator.version],
    ["image", paths.image(), manifest.image.id],
  ]) {
    const archive = manifest[name].archives[key];
    fs.rmSync(directory, { recursive: true, force: true });
    for (const file of known.contents.get(archive.url)) {
      const target = path.join(directory, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, file.content, { mode: file.mode });
      fs.chmodSync(target, file.mode);
    }
    fs.writeFileSync(
      path.join(directory, receiptFile),
      JSON.stringify({ version, sha256: archive.sha256 }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  return paths;
}
