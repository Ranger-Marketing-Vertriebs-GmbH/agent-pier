import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { actionsFixture, refused } from "../helpers/device-actions-fixture.js";

// The actions for apps, files, logs and the device's shell (device-app-actions.js),
// on a device source in memory whose adb answers are scripted.
const invalid = refused("DEVICE_INPUT_INVALID", 400);
const outside = refused("DEVICE_PATH_OUTSIDE", 403);
const first = (f) => f.adb.map(({ args }) => args);
// What the device's `cat` sends, as AdbClient hands it on: chunk by chunk to
// `onData`, cut at `maxBytes`.
function sent(options, content) {
  const bytes = Buffer.from(content);
  const cut = bytes.length > options.maxBytes;
  options.onData(cut ? bytes.subarray(0, options.maxBytes) : bytes);
  return cut ? { code: null, truncated: true } : {};
}
const statOf = (args) => args[0] === "shell" && args[1].startsWith("stat ");

test("apps are listed by name, third-party by default, bounded", async (t) => {
  const f = actionsFixture(t, { limits: { apps: 3 } });
  await f.owned("Pixel");
  f.answers(() => ({
    stdout: "package:org.example.b\npackage:com.example.a\n\nnoise\npackage:bad name\n",
  }));
  assert.deepEqual(await f.run("apps", { device: "Pixel" }), {
    packages: ["com.example.a", "org.example.b"],
    total: 2,
    truncated: false,
  });
  await f.run("apps", { device: "Pixel", all: true });
  assert.deepEqual(first(f), [
    ["shell", "pm list packages -3"],
    ["shell", "pm list packages"],
  ]);
  f.answers(() => ({
    stdout: ["e", "d", "c", "b", "a"].map((name) => `package:x.${name}\n`).join(""),
  }));
  assert.deepEqual(await f.run("apps", { device: "Pixel" }), {
    packages: ["x.a", "x.b", "x.c"],
    total: 5,
    truncated: true,
    note: "Showing the first 3 packages.",
  });
  await assert.rejects(f.run("apps", { device: "Pixel", all: "yes" }), invalid);
});

test("an app starts by its launcher activity or a named one", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers(([, command]) =>
    command.startsWith("cmd package")
      ? {
          stdout:
            "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n" +
            "com.android.settings/.Settings\n",
        }
      : { stdout: "Starting: Intent { cmp=com.android.settings/.Settings }\n" },
  );
  assert.deepEqual(
    await f.run("app_launch", { device: "Pixel", package: "com.android.settings" }),
    { launched: "com.android.settings/.Settings" },
  );
  assert.deepEqual(
    await f.run("app_launch", {
      device: "Pixel",
      package: "com.example.app",
      activity: ".Main",
    }),
    { launched: "com.example.app/.Main" },
  );
  assert.deepEqual(first(f), [
    [
      "shell",
      "cmd package resolve-activity --brief -c android.intent.category.LAUNCHER 'com.android.settings'",
    ],
    ["shell", "am start -n 'com.android.settings/.Settings'"],
    ["shell", "am start -n 'com.example.app/.Main'"],
  ]);
  assert.deepEqual(
    await f.run("app_stop", { device: "Pixel", package: "com.example.app" }),
    {
      stopped: "com.example.app",
    },
  );
  assert.deepEqual(f.adb.at(-1).args, ["shell", "am force-stop 'com.example.app'"]);
});

test("an app that is not there, or does not start, is a refusal with a reason", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers(() => ({ stdout: "No activity found\n" }));
  await assert.rejects(
    f.run("app_launch", { device: "Pixel", package: "com.nope.missing" }),
    refused("DEVICE_COMMAND_FAILED", 409, /not installed or has no launcher activity/),
  );
  // What the device names as the activity is never trusted as a word of its own.
  f.answers(() => ({ stdout: "com.nope.missing/.Main; reboot\n" }));
  await assert.rejects(
    f.run("app_launch", { device: "Pixel", package: "com.nope.missing" }),
    refused("DEVICE_COMMAND_FAILED"),
  );
  f.answers(() => ({ stdout: "com.other.app/.Main\n" }));
  await assert.rejects(
    f.run("app_launch", { device: "Pixel", package: "com.nope.missing" }),
    refused("DEVICE_COMMAND_FAILED"),
  );
  assert.equal(f.adb.length, 3, "nothing was started");
  f.answers(() => ({
    code: 1,
    stdout: "Starting: Intent { cmp=com.nope.missing/.Main }\n",
    stderr:
      "Error type 3\nError: Activity class {com.nope.missing/com.nope.missing.Main} does not exist.\n",
  }));
  await assert.rejects(
    f.run("app_launch", {
      device: "Pixel",
      package: "com.nope.missing",
      activity: ".Main",
    }),
    refused("DEVICE_COMMAND_FAILED", 409, /does not exist/),
  );
});

test("package, activity and URL cannot carry a command or an option", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  for (const [action, input] of [
    ["app_launch", { package: "com.example; reboot" }],
    ["app_launch", { package: "-n" }],
    ["app_launch", { package: "com.example.app", activity: "Main -a x" }],
    ["app_launch", { package: "com.example.app", activity: "$(reboot)" }],
    ["app_launch", {}],
    ["app_stop", { package: "com.example.app'; reboot; '" }],
    ["app_stop", {}],
    ["open_url", { url: "https://a b" }],
    ["open_url", { url: "-d" }],
    ["open_url", { url: "example.com" }],
    ["open_url", {}],
    ["logs", { package: "x y" }],
    ["logs", { tag: "a b" }],
    ["logs", { tag: "-s" }],
    ["logs", { priority: "*" }],
    ["logs", { lines: 0 }],
    ["logs", { lines: 1001 }],
  ])
    await assert.rejects(
      f.run(action, { device: "Pixel", ...input }),
      invalid,
      JSON.stringify(input),
    );
  assert.deepEqual(f.adb, []);
});

test("a URL is one quoted word, whatever it contains", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers(() => ({ stdout: "Starting: Intent { act=android.intent.action.VIEW }\n" }));
  const link = "https://example.com/?a=1&b=$HOME;id#'`x`";
  assert.deepEqual(await f.run("open_url", { device: "Pixel", url: link }), {
    opened: link,
  });
  await f.run("open_url", { device: "Pixel", url: "myapp://open/7" });
  assert.deepEqual(first(f), [
    [
      "shell",
      "am start -a android.intent.action.VIEW -d 'https://example.com/?a=1&b=$HOME;id#'\\''`x`'",
    ],
    ["shell", "am start -a android.intent.action.VIEW -d 'myapp://open/7'"],
  ]);
  f.answers(() => ({
    code: 1,
    stderr:
      "Error: Activity not started, unable to resolve Intent { dat=nope://x/... }\n",
  }));
  await assert.rejects(
    f.run("open_url", { device: "Pixel", url: "nope://x" }),
    refused("DEVICE_COMMAND_FAILED", 409, /unable to resolve Intent/),
  );
});

test("logs are the latest lines, filtered and bounded", async (t) => {
  const f = actionsFixture(t, { limits: { outputBytes: 80 } });
  await f.owned("Pixel");
  const line = (n) => `11-28 15:09:40.${String(n).padStart(3, "0")}  1  2 I tag: m${n}`;
  f.answers(() => ({
    stdout: `--------- beginning of main\n${line(1)}\n${line(2)}\n--------- beginning of system\n${line(3)}\n`,
  }));
  assert.deepEqual(await f.run("logs", { device: "Pixel", lines: 2 }), {
    lines: [line(2), line(3)],
    truncated: false,
  });
  // More than the byte limit: the latest whole lines stay.
  assert.deepEqual(await f.run("logs", { device: "Pixel" }), {
    lines: [line(2), line(3)],
    truncated: true,
    note: "Showing the last 2 lines.",
  });
  await f.run("logs", { device: "Pixel", priority: "W" });
  await f.run("logs", { device: "Pixel", tag: "ActivityManager" });
  await f.run("logs", { device: "Pixel", tag: "My.Tag", priority: "E", lines: 7 });
  assert.deepEqual(first(f), [
    ["shell", "logcat -d -v threadtime -t 2"],
    ["shell", "logcat -d -v threadtime -t 100"],
    // With a filter logcat cuts first and filters afterwards, so more is read.
    ["shell", "logcat -d -v threadtime -t 5000 '*:W'"],
    ["shell", "logcat -d -v threadtime -t 5000 -s 'ActivityManager:V'"],
    ["shell", "logcat -d -v threadtime -t 5000 -s 'My.Tag:E'"],
  ]);
  assert.equal(f.adb[0].options.maxBytes, 2 * 2 ** 20);
  // What adb cut off in the middle of a line is not shown as a line.
  f.answers(() => ({
    stdout: `${line(1)}\n${line(2).slice(0, 9)}`,
    truncated: true,
    code: null,
  }));
  assert.deepEqual((await f.run("logs", { device: "Pixel", lines: 5 })).lines, [line(1)]);
  f.answers(() => ({ code: 1, stderr: "logcat: boom" }));
  await assert.rejects(
    f.run("logs", { device: "Pixel" }),
    refused("DEVICE_COMMAND_FAILED", 409, "logcat: boom"),
  );
});

test("the logs of an app are those of its process", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers(([, command]) =>
    command.startsWith("pidof") ? { stdout: "4711\n" } : { stdout: "a line\n" },
  );
  assert.deepEqual(await f.run("logs", { device: "Pixel", package: "com.example.app" }), {
    lines: ["a line"],
    truncated: false,
  });
  assert.deepEqual(first(f), [
    ["shell", "pidof -s 'com.example.app'"],
    ["shell", "logcat -d -v threadtime -t 100 --pid=4711"],
  ]);
  // Not running, or an answer that is no process id: nothing is read.
  for (const answer of [{ code: 1, stdout: "" }, { stdout: "4711; reboot\n" }]) {
    f.answers(() => answer);
    const before = f.adb.length;
    assert.deepEqual(
      await f.run("logs", { device: "Pixel", package: "com.example.app" }),
      {
        lines: [],
        truncated: false,
        note: "com.example.app is not running.",
      },
    );
    assert.equal(f.adb.length, before + 1);
  }
});

test("a shell command is one argument for the device, with a timeout and a limit", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  const command =
    "getprop ro.build.version.sdk; echo \"$HOME\" 'x' | cat && rm -rf /sdcard/x";
  f.answers(() => ({ stdout: "36\n", stderr: "warn\n", code: 3 }));
  assert.deepEqual(await f.run("shell", { device: "Pixel", command }), {
    exitCode: 3,
    stdout: "36\n",
    stderr: "warn\n",
    truncated: false,
  });
  // The command is the one argument after `shell`, unchanged.
  assert.deepEqual(f.adb[0].args, ["shell", command]);
  assert.equal(f.adb[0].options.timeoutMs, 30000);
  assert.equal(f.adb[0].options.maxBytes, 65536);
  await f.run("shell", { device: "Pixel", command: "sleep 100", timeoutMs: 120000 });
  assert.equal(f.adb[1].options.timeoutMs, 120000);
  // Output at the limit: adb ended the command.
  f.answers(() => ({ stdout: "y".repeat(65536), code: null, truncated: true }));
  const cut = await f.run("shell", { device: "Pixel", command: "yes" });
  assert.equal(cut.exitCode, null);
  assert.equal(cut.truncated, true);
  assert.equal(cut.note, "The output was cut at 65536 bytes and the command was ended.");
  f.answers(() => ({ stdout: "", stderr: "e".repeat(20000) }));
  const errors = await f.run("shell", { device: "Pixel", command: "noisy" });
  assert.equal(errors.stderr.length, 16384);
  assert.equal(errors.note, "The output was cut at 65536 bytes.");
  const before = f.adb.length;
  for (const input of [
    {},
    { command: "" },
    { command: "   " },
    { command: "a\0b" },
    { command: "x".repeat(8001) },
    // adb would take these as options of its own `shell`.
    { command: "-x id" },
    { command: "  -e none id" },
    { command: "id", timeoutMs: 999 },
    { command: "id", timeoutMs: 120001 },
    { command: "id", timeoutMs: "30000" },
    { command: ["id"] },
  ])
    await assert.rejects(
      f.run("shell", { device: "Pixel", ...input }),
      invalid,
      JSON.stringify(input).slice(0, 60),
    );
  assert.equal(f.adb.length, before);
  // A command that does not end in time is adb's timeout.
  f.answers(() => {
    throw Object.assign(Error("DEVICE_ADB_TIMEOUT"), {
      code: "DEVICE_ADB_TIMEOUT",
      status: 409,
    });
  });
  await assert.rejects(
    f.run("shell", { device: "Pixel", command: "sleep 1000" }),
    refused("DEVICE_ADB_TIMEOUT"),
  );
});

test("an APK of the area is installed from a private copy", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  let staged = null;
  f.answers((args) => {
    staged = { file: args[2], content: fs.readFileSync(args[2], "utf8") };
    return { stdout: "Performing Streamed Install\nSuccess\n" };
  });
  assert.deepEqual(await f.run("install", { device: "Pixel", path: "build/app.apk" }), {
    installed: "app.apk",
    bytes: 9,
  });
  assert.deepEqual(f.adb[0].args.slice(0, 2), ["install", "-r"]);
  assert.equal(f.adb[0].args.length, 3);
  // adb read the server's copy, never a path of the area.
  assert.equal(staged.content, "apk bytes");
  assert.ok(staged.file.startsWith(f.transfers + path.sep), staged.file);
  assert.equal(path.basename(staged.file), "app.apk");
  assert.deepEqual(fs.readdirSync(f.transfers), [], "the copy is gone");
  // A failed installation names the reason, without the server's path.
  f.answers((args) => ({
    code: 1,
    stdout: "Performing Streamed Install\n",
    stderr: `adb: failed to install ${args[2]}: Failure [INSTALL_FAILED_INVALID_APK]\n`,
  }));
  await assert.rejects(
    f.run("install", { device: "Pixel", path: "build/app.apk" }),
    (error) => {
      assert.equal(error.code, "DEVICE_COMMAND_FAILED");
      assert.equal(
        error.detail,
        "adb: failed to install app.apk: Failure [INSTALL_FAILED_INVALID_APK]",
      );
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(f.transfers), []);
  // A file that is no APK is not handed to adb.
  fs.writeFileSync(path.join(f.area, "notes.txt"), "x");
  const before = f.adb.length;
  await assert.rejects(f.run("install", { device: "Pixel", path: "notes.txt" }), invalid);
  await assert.rejects(f.run("install", { device: "Pixel" }), invalid);
  assert.equal(f.adb.length, before);
});

test("no host path outside the area reaches adb, in either direction", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  const secret = path.join(f.area, "..", `secret-${path.basename(f.area)}.apk`);
  fs.writeFileSync(secret, "the secret");
  t.after(() => fs.rmSync(secret, { force: true }));
  fs.symlinkSync(secret, path.join(f.area, "leak.apk"));
  fs.symlinkSync(path.dirname(f.area), path.join(f.area, "up"));
  fs.writeFileSync(path.join(f.dataDir, "token.apk"), "private");
  f.answers(() => ({ stdout: "regular file|5\n" }));
  for (const requested of [
    `../${path.basename(secret)}`,
    secret,
    "leak.apk",
    `up/${path.basename(secret)}`,
    "/etc/hosts",
    path.join(f.dataDir, "token.apk"),
  ]) {
    await assert.rejects(f.run("install", { device: "Pixel", path: requested }), outside);
    await assert.rejects(
      f.run("push", { device: "Pixel", path: requested, devicePath: "/sdcard/x" }),
      outside,
      requested,
    );
  }
  for (const requested of [
    "../escaped.txt",
    "up/escaped.txt",
    "leak.apk",
    "/tmp/agentpier-device-escape.txt",
    path.join(f.dataDir, "pulled.txt"),
  ])
    await assert.rejects(
      f.run("pull", { device: "Pixel", devicePath: "/sdcard/x", path: requested }),
      outside,
      requested,
    );
  // Refused before the device was asked anything, and before it was started.
  assert.deepEqual(f.adb, []);
  assert.deepEqual(f.source.calls("start"), []);
  assert.equal(fs.readFileSync(secret, "utf8"), "the secret");
  assert.equal(fs.existsSync(path.join(path.dirname(f.area), "escaped.txt")), false);
  // A caller without an area copies nothing.
  await assert.rejects(
    f.run(
      "push",
      { device: "Pixel", path: "build/app.apk", devicePath: "/sdcard/x" },
      {
        area: () => null,
      },
    ),
    outside,
  );
  await assert.rejects(f.run("install", { device: "Pixel", path: "build/missing.apk" }), {
    code: "DEVICE_FILE_NOT_FOUND",
  });
});

test("a file goes to the device as one argument, under its own name", async (t) => {
  const f = actionsFixture(t, { limits: { pushBytes: 20 } });
  await f.owned("Pixel");
  let staged = null;
  f.answers((args) => {
    staged = { file: args[1], content: fs.readFileSync(args[1], "utf8") };
    return {
      stderr: `${args[1]}: 1 file pushed, 0 skipped. 21.8 MB/s (9 bytes in 0.000s)\n`,
    };
  });
  const remote = "/sdcard/Download/my file's.apk";
  assert.deepEqual(
    await f.run("push", { device: "Pixel", path: "build/app.apk", devicePath: remote }),
    { pushed: remote, bytes: 9 },
  );
  assert.deepEqual(f.adb[0].args, ["push", staged.file, remote]);
  assert.equal(staged.content, "apk bytes");
  assert.equal(path.basename(staged.file), "app.apk");
  assert.ok(staged.file.startsWith(f.transfers + path.sep));
  assert.deepEqual(fs.readdirSync(f.transfers), []);
  const before = f.adb.length;
  for (const devicePath of ["sdcard/x", "-a", "/sdcard/", "/sdcard/../x", "", undefined])
    await assert.rejects(
      f.run("push", { device: "Pixel", path: "build/app.apk", devicePath }),
      invalid,
    );
  fs.writeFileSync(path.join(f.area, "big.bin"), "x".repeat(21));
  await assert.rejects(
    f.run("push", { device: "Pixel", path: "big.bin", devicePath: "/sdcard/big" }),
    (error) => error.code === "DEVICE_FILE_TOO_LARGE" && error.limit === 20,
  );
  assert.equal(f.adb.length, before);
  f.answers((args) => ({
    code: 1,
    stderr: `adb: error: failed to copy '${args[1]}' to '/system/x': remote couldn't create file: Read-only file system\n`,
  }));
  await assert.rejects(
    f.run("push", { device: "Pixel", path: "build/app.apk", devicePath: "/system/x" }),
    refused(
      "DEVICE_COMMAND_FAILED",
      409,
      "adb: error: failed to copy 'app.apk' to '/system/x': remote couldn't create file: Read-only file system",
    ),
  );
});

test("a file comes from the device into the area, bounded", async (t) => {
  const f = actionsFixture(t, { limits: { pullBytes: 30 } });
  await f.owned("Pixel");
  const device = (content) =>
    f.answers((args, options) =>
      statOf(args)
        ? { stdout: `regular file|${content.length}\n` }
        : sent(options, content),
    );
  device("from the device");
  const remote = "/sdcard/Download/it's here.txt";
  assert.deepEqual(
    await f.run("pull", {
      device: "Pixel",
      devicePath: remote,
      path: "build/pulled.txt",
    }),
    { pulled: "pulled.txt", bytes: 15 },
  );
  assert.equal(
    fs.readFileSync(path.join(f.area, "build", "pulled.txt"), "utf8"),
    "from the device",
  );
  assert.deepEqual(f.adb[0].args, [
    "shell",
    "stat -L -c '%F|%s' '/sdcard/Download/it'\\''s here.txt'",
  ]);
  // The bytes come as the output of the device's `cat`, cut at the limit; adb gets
  // no path of the host.
  assert.deepEqual(f.adb[1].args, [
    "shell",
    "-T",
    "cat '/sdcard/Download/it'\\''s here.txt'",
  ]);
  assert.equal(f.adb[1].options.maxBytes, 30);
  assert.deepEqual(fs.readdirSync(f.transfers), []);
  // Larger than the limit by what the device says: not copied at all.
  f.answers(() => ({ stdout: "regular file|31\n" }));
  await assert.rejects(
    f.run("pull", { device: "Pixel", devicePath: remote, path: "big.txt" }),
    (error) => error.code === "DEVICE_FILE_TOO_LARGE" && error.limit === 30,
  );
  // Grown since its size was read: what arrived is not written to the area.
  f.answers((args, options) =>
    statOf(args) ? { stdout: "regular file|5\n" } : sent(options, "x".repeat(31)),
  );
  await assert.rejects(
    f.run("pull", { device: "Pixel", devicePath: remote, path: "big.txt" }),
    { code: "DEVICE_FILE_TOO_LARGE" },
  );
  assert.equal(fs.existsSync(path.join(f.area, "big.txt")), false);
  // No regular file on the device.
  for (const answer of [
    { stdout: "directory|4096\n" },
    { stdout: "character special file|0\n" },
    { code: 1, stderr: "stat: '/sdcard/nope': No such file or directory\n" },
    { stdout: "regular file|many\n" },
  ]) {
    f.answers(() => answer);
    const before = f.adb.length;
    await assert.rejects(
      f.run("pull", { device: "Pixel", devicePath: "/sdcard/nope", path: "x.txt" }),
      (error) => ["DEVICE_FILE_NOT_FOUND", "DEVICE_FILE_TOO_LARGE"].includes(error.code),
    );
    assert.equal(f.adb.length, before + 1, "nothing was pulled");
  }
  assert.deepEqual(fs.readdirSync(f.transfers), []);
  assert.deepEqual(fs.readdirSync(f.area).sort(), ["build"]);
});

test("a caller whose folder may be read-only for it pulls nothing", async (t) => {
  const f = actionsFixture(t);
  await f.owned("Pixel");
  f.answers(() => ({ stdout: "regular file|5\n" }));
  await assert.rejects(
    f.run(
      "pull",
      { device: "Pixel", devicePath: "/sdcard/x", path: "x.txt" },
      { areaWritable: () => false },
    ),
    refused("DEVICE_PULL_SANDBOXED", 403),
  );
  assert.deepEqual(f.adb, []);
  assert.deepEqual(f.source.calls("start"), []);
  // Reading from the folder stays possible.
  f.answers(() => ({ stdout: "Performing Streamed Install\nSuccess\n" }));
  await f.run(
    "install",
    { device: "Pixel", path: "build/app.apk" },
    { areaWritable: () => false },
  );
});

test("a pull is one bounded stream, whatever the device path has become", async (t) => {
  const f = actionsFixture(t, { limits: { pullBytes: 30 } });
  await f.owned("Pixel");
  const pull = () =>
    f.run("pull", { device: "Pixel", devicePath: "/sdcard/log", path: "log.txt" });
  const clean = () => {
    assert.deepEqual(fs.readdirSync(f.transfers), []);
    assert.equal(fs.existsSync(path.join(f.area, "log.txt")), false);
    // adb is never told to copy to a place on the host: a device path that is a
    // folder by then would arrive as a tree of any size.
    assert.equal(
      f.adb.some(({ args }) => args[0] === "pull"),
      false,
    );
  };
  // A regular file when its size was read, a folder when it is copied.
  f.answers((args, options) => {
    if (statOf(args)) return { stdout: "regular file|5\n" };
    if (args[0] === "pull") {
      fs.mkdirSync(args[2]);
      fs.writeFileSync(path.join(args[2], "big"), "x".repeat(100));
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve({}));
        setTimeout(() => resolve({}), 300);
      });
    }
    return { code: 1, stderr: "cat: /sdcard/log: Is a directory\n" };
  });
  await assert.rejects(pull(), refused("DEVICE_FILE_NOT_FOUND", 404, /Is a directory/));
  clean();
  // A file that grew since its size was read ends at the limit.
  f.answers((args, options) =>
    statOf(args) ? { stdout: "regular file|5\n" } : sent(options, "x".repeat(100)),
  );
  await assert.rejects(
    pull(),
    (error) => error.code === "DEVICE_FILE_TOO_LARGE" && error.limit === 30,
  );
  clean();
  // Exactly the limit passes, byte for byte.
  const bytes = Buffer.from(Array.from({ length: 30 }, (_, index) => (index * 37) % 256));
  f.answers((args, options) =>
    statOf(args) ? { stdout: "regular file|30\n" } : sent(options, bytes),
  );
  assert.deepEqual(await pull(), { pulled: "log.txt", bytes: 30 });
  assert.deepEqual(fs.readFileSync(path.join(f.area, "log.txt")), bytes);
});

test("a pull whose call has ended writes nothing into the area", async (t) => {
  const f = actionsFixture(t, { callTimeoutMs: 40 });
  await f.owned("Pixel");
  let release;
  f.answers((args, options) => {
    if (statOf(args)) return { stdout: "regular file|4\n" };
    if (args[0] === "pull") fs.writeFileSync(args[2], "late");
    else options.onData(Buffer.from("late"));
    // adb goes on although its call was aborted, and ends well.
    return new Promise((resolve) => (release = () => resolve({})));
  });
  await assert.rejects(
    f.run("pull", { device: "Pixel", devicePath: "/sdcard/x", path: "late.txt" }),
    refused("DEVICE_CALL_TIMEOUT", 409),
  );
  release();
  // What is left of the call ends by itself: its private folder goes away.
  for (let wait = 0; wait < 100 && fs.readdirSync(f.transfers).length; wait++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fs.readdirSync(f.transfers), []);
  assert.deepEqual(fs.readdirSync(f.area), ["build"]);
});

test("what an earlier process left of a transfer is removed at the start", async (t) => {
  const f = actionsFixture(t);
  const left = path.join(f.transfers, "abc", "payload");
  fs.mkdirSync(path.dirname(left), { recursive: true });
  fs.writeFileSync(left, "left over");
  const { DeviceActions } =
    await import("../../server/features/devices/device-actions.js");
  new DeviceActions({ devices: f.service, dataDir: f.dataDir });
  assert.equal(fs.existsSync(f.transfers), false);
});
