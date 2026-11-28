// What the fake adb (fake-adb.mjs) answers for the calls of the device tools, as the
// pinned emulator answered them (Android 16, platform-tools 37.0.3; recorded on
// 2026-11-28). The device is a few files in the fake's state folder:
//
//   <state>/device-<serial>.json    { typed, events, packages, running, opened }
//   <state>/files-<serial>/…        the device's files, by their device path
//
// `behaviour.json` may hold `screenshotPadding` (bytes added to a screenshot).
//
// A shell command is read as the device's shell reads the commands AgentPier
// builds: words separated by blanks, a word or a part of one in single quotes
// (`'it'\''s'`), and commands joined by `&&`. Nothing is expanded and nothing is
// ever run on the host. A command this file does not know is echoed, or answered by
// `behaviour.json` (`shell: { stdout, code, delayMs }`), as before.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(new URL("./android/", import.meta.url));
const system = {
  "com.android.settings": ".Settings",
  "com.android.chrome": "com.google.android.apps.chrome.Main",
};
const log = [
  [
    667,
    "I",
    "ActivityTaskManager",
    "START u0 {act=android.intent.action.MAIN} result code=2",
  ],
  [667, "W", "ActivityTaskManager", "callingPackage for (uid=-1, pid=0) has no WPC"],
  [1813, "I", "wwc", "(REDACTED) New recognizer: %s"],
  [1895, "W", "adua", "Abort, client detached."],
  [667, "D", "WifiNative", "interfaceLinkStateChanged: ifaceName=eth0"],
  [1565, "E", "ModuleInitIntentOp", "Dropping unexpected action"],
];
const priorities = ["V", "D", "I", "W", "E", "F"];

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const frame = Buffer.alloc(8 + data.length + 4);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(zlib.crc32(body), 8 + data.length);
  return frame;
};
/**
 * A valid, empty PNG of `width` by `height` (RGBA), as `screencap -p` writes one,
 * with `padding` further bytes in a private chunk (a screen full of detail).
 */
export function png(width, height, padding = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(height * (1 + width * 4)))),
    ...(padding ? [chunk("prVt", Buffer.alloc(padding, 0x5a))] : []),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * `command` as lists of words, one per command joined by `&&`; null when it uses
 * anything of a shell beyond blanks and single quotes.
 */
export function shellWords(command) {
  const commands = [[]];
  let word = null;
  const end = () => {
    if (word !== null) commands.at(-1).push(word);
    word = null;
  };
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (char === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return null;
      word = (word ?? "") + command.slice(at + 1, close);
      at = close;
    } else if (char === "\\" && command[at + 1] === "'") {
      word = (word ?? "") + "'";
      at++;
    } else if (char === " ") end();
    else if (command.startsWith("&&", at)) {
      end();
      commands.push([]);
      at++;
    } else if (/[A-Za-z0-9_.:\/=*%+,@-]/.test(char)) word = (word ?? "") + char;
    else return null;
  }
  end();
  return commands.every((words) => words.length) ? commands : null;
}

/** The fake device `serial` in the state folder `state`. */
export function fakeDevice(state, serial) {
  const file = path.join(state, `device-${serial}.json`);
  const files = path.join(state, `files-${serial}`);
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { typed: "", events: [], packages: {}, running: {}, opened: [] };
    }
  };
  const change = (patch) => {
    const next = patch(read());
    fs.writeFileSync(file, JSON.stringify(next));
    return next;
  };
  // Where a path of the device lies in the state folder; null outside of it.
  const local = (remote) => {
    const target = path.join(files, path.posix.normalize(`/${remote}`));
    return target.startsWith(files + path.sep) ? target : null;
  };
  const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
  const activity = (name) => system[name] ?? read().packages[name] ?? null;

  function program([name, ...args]) {
    if (name === "wm" && args[0] === "size") return ok("Physical size: 720x1600\n");
    if (name === "input") {
      const [verb, ...rest] = args;
      if (verb === "text") {
        // `input text` makes a space of `%s`.
        const text = (rest[0] ?? "").replaceAll("%s", " ");
        change((device) => ({ ...device, typed: device.typed + text }));
      } else
        change((device) => ({ ...device, events: [...device.events, args.join(" ")] }));
      return ok();
    }
    if (name === "pm" && args[0] === "list" && args[1] === "packages") {
      const installed = Object.keys(read().packages);
      const names = args.includes("-3")
        ? installed
        : [...Object.keys(system), ...installed];
      return ok(names.map((entry) => `package:${entry}\n`).join(""));
    }
    if (name === "cmd" && args[0] === "package" && args[1] === "resolve-activity") {
      const target = args.at(-1);
      const found = activity(target);
      return ok(
        found
          ? "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n" +
              `${target}/${found}\n`
          : "No activity found\n",
      );
    }
    if (name === "am" && args[0] === "start" && args[1] === "-n") {
      const component = args[2] ?? "";
      const [target, short = ""] = component.split("/");
      if (!activity(target))
        return {
          stdout: `Starting: Intent { cmp=${component} }\n`,
          stderr: `Error type 3\nError: Activity class {${target}/${short.startsWith(".") ? target + short : short}} does not exist.\n`,
          code: 1,
        };
      change((device) => ({
        ...device,
        running: {
          ...device.running,
          [target]: 4000 + Object.keys(device.running).length,
        },
      }));
      return ok(`Starting: Intent { cmp=${component} }\n`);
    }
    if (name === "am" && args[0] === "start" && args[1] === "-a") {
      const link = args[args.indexOf("-d") + 1] ?? "";
      const origin = /^[^:]+:\/\/[^/]*/.exec(link)?.[0] ?? link;
      const intent = `act=android.intent.action.VIEW dat=${origin}/...`;
      if (!/^https?:|^fakeapp:/.test(link))
        return {
          stdout: `Starting: Intent { ${intent} }\n`,
          stderr: `Error: Activity not started, unable to resolve Intent { ${intent} flg=0x10000000 xflg=0x4 }\n`,
          code: 1,
        };
      change((device) => ({ ...device, opened: [...device.opened, link] }));
      return ok(`Starting: Intent { ${intent} }\n`);
    }
    if (name === "am" && args[0] === "force-stop") {
      change((device) => {
        const { [args[1]]: _stopped, ...running } = device.running;
        return { ...device, running };
      });
      return ok();
    }
    if (name === "pidof") {
      const pid = read().running[args.at(-1)];
      return pid ? ok(`${pid}\n`) : { stdout: "", stderr: "", code: 1 };
    }
    if (name === "logcat") {
      const count = Number(args[args.indexOf("-t") + 1]) || log.length;
      const pid = Number(args.find((arg) => arg.startsWith("--pid="))?.slice(6)) || null;
      const spec = args.find((arg) => /^[^-].*:[VDIWEF*]$/.test(arg) && arg !== "-t");
      const [tag, priority] = spec ? spec.split(":") : ["*", "V"];
      const least = priority === "*" ? 0 : priorities.indexOf(priority);
      // The last lines first, then the filter, as logcat does.
      const lines = log
        .filter((entry) => !pid || entry[0] === pid)
        .slice(-count)
        .filter(
          (entry) =>
            (tag === "*" || entry[2] === tag) && priorities.indexOf(entry[1]) >= least,
        )
        .map(
          ([id, level, name, text], index) =>
            `11-28 15:09:40.${String(700 + index)} ${String(id).padStart(5)} ${String(id + 1).padStart(5)} ${level} ${name.padEnd(8)}: ${text}\n`,
        );
      return ok(lines.length ? `--------- beginning of main\n${lines.join("")}` : "");
    }
    if (name === "stat") {
      const remote = args.at(-1);
      const target = local(remote);
      const found = target && fs.existsSync(target) ? fs.statSync(target) : null;
      if (!found)
        return {
          stdout: "",
          stderr: `stat: '${remote}': No such file or directory\n`,
          code: 1,
        };
      return ok(
        found.isDirectory() ? "directory|4096\n" : `regular file|${found.size}\n`,
      );
    }
    return null;
  }

  return {
    read,
    files,
    local,
    /** `adb shell <command>`, or null when this file has no answer of its own. */
    shell(command) {
      const commands = shellWords(command);
      if (!commands) return null;
      let answer = null;
      for (const words of commands) {
        const next = program(words);
        if (!next) return null;
        answer = {
          stdout: (answer?.stdout ?? "") + next.stdout,
          stderr: (answer?.stderr ?? "") + next.stderr,
          code: next.code,
        };
        if (next.code !== 0) break;
      }
      return answer;
    },
    /** `adb exec-out <args>`: a Buffer, or null. */
    execOut(args) {
      if (args.join(" ") === "screencap -p") {
        // `behaviour.json` may ask for a larger picture: `screenshotPadding` bytes.
        let behaviour = {};
        try {
          behaviour = JSON.parse(
            fs.readFileSync(path.join(state, "behaviour.json"), "utf8"),
          );
        } catch {
          // No behaviour.
        }
        return png(720, 1600, Number(behaviour.screenshotPadding) || 0);
      }
      if (args.join(" ") === "uiautomator dump /dev/tty")
        return fs.readFileSync(path.join(fixtures, "ui-dump-settings-search.xml"));
      return null;
    },
    install(file) {
      const stdout = "Performing Streamed Install\n";
      if (!/\.(?:apk|apex)$/.test(file))
        return {
          stdout,
          stderr: `adb: filename doesn't end .apk or .apex: ${file}\n`,
          code: 1,
        };
      // A fake package is a text file: `fake-apk:<package>`.
      const name = /^fake-apk:([\w.]+)/.exec(fs.readFileSync(file, "utf8"))?.[1];
      if (!name)
        return {
          stdout,
          stderr: `adb: failed to install ${file}: Failure [INSTALL_PARSE_FAILED_NOT_APK: Failed to parse /data/app/vmdl1043003878.tmp/base.apk: Failed to load asset path /data/app/vmdl1043003878.tmp/base.apk]\n`,
          code: 1,
        };
      change((device) => ({
        ...device,
        packages: { ...device.packages, [name]: ".MainActivity" },
      }));
      return { stdout: `${stdout}Success\n`, stderr: "", code: 0 };
    },
    push(source, remote) {
      const size = fs.statSync(source).size;
      const pushed = `${source}: 1 file pushed, 0 skipped. 21.8 MB/s (${size} bytes in 0.000s)\n`;
      let target = local(remote);
      if (!target || remote.startsWith("/system/"))
        return {
          stdout: "",
          stderr: `${pushed}adb: error: failed to copy '${source}' to '${remote}': remote couldn't create file: Read-only file system\n`,
          code: 1,
        };
      // Onto a folder of the device the file keeps its name.
      if (fs.existsSync(target) && fs.statSync(target).isDirectory())
        target = path.join(target, path.basename(source));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return { stdout: "", stderr: pushed, code: 0 };
    },
    pull(remote, target) {
      const source = local(remote);
      if (!source || !fs.existsSync(source))
        return {
          stdout: "",
          stderr: `adb: error: failed to stat remote object '${remote}': No such file or directory\n`,
          code: 1,
        };
      fs.copyFileSync(source, target);
      const size = fs.statSync(source).size;
      return {
        stdout: "",
        stderr: `${remote}: 1 file pulled, 0 skipped. 1.7 MB/s (${size} bytes in 0.001s)\n`,
        code: 0,
      };
    },
  };
}
