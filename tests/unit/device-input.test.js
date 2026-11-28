import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fc from "fast-check";
import {
  KEYS,
  KEY_NAMES,
  activityName,
  bounded,
  brief,
  devicePath,
  keyCommand,
  logPriority,
  logTag,
  longPressCommand,
  packageName,
  point,
  scrollPoints,
  shellWord,
  swipeCommand,
  tapCommand,
  typeCommand,
  url,
} from "../../server/features/devices/device-input.js";

// What a tool call may hand to the device's shell (device-input.js). The device's
// shell is mksh; a POSIX `sh` on this host reads single-quoted words the same way,
// so it stands in to prove the quoting.
const words = (command) =>
  execFileSync("/bin/sh", [
    "-c",
    `for word in ${command}; do printf '%s\\0' "$word"; done`,
  ])
    .toString()
    .split("\0")
    .slice(0, -1);
const refused = (code, detail) => (error) =>
  error.code === code && (detail === undefined || error.detail === detail);

test("a shell word reaches the shell as exactly the text it was made from", () => {
  const nasty = "$HOME;`id`\"q\"'x'\\n&|<>(){}[]*?!~# $(reboot) \\";
  assert.deepEqual(words(shellWord(nasty)), [nasty]);
  assert.deepEqual(words(shellWord("")), [""]);
  assert.deepEqual(words(shellWord("-rf")), ["-rf"]);
  assert.equal(shellWord("it's"), "'it'\\''s'");
  assert.throws(() => shellWord("a\0b"), refused("DEVICE_INPUT_INVALID"));
  assert.throws(() => shellWord(7), refused("DEVICE_INPUT_INVALID"));
});

test("property: no printable text escapes its shell word", () => {
  fc.assert(
    fc.property(
      fc.string({
        unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
        maxLength: 60,
      }),
      (text) => {
        assert.deepEqual(words(shellWord(text)), [text]);
      },
    ),
    { numRuns: 60 },
  );
});

// What the shell hands to `input text`, piece by piece.
function typed(text) {
  const command = typeCommand(text);
  const pieces = command.split(" && ").map((part) => {
    assert.match(part, /^input text '/);
    const [input, verb, ...rest] = words(part);
    assert.deepEqual([input, verb], ["input", "text"]);
    assert.equal(rest.length, 1, "one argument per call");
    return rest[0];
  });
  return pieces;
}

test("typed text is literal: spaces, quotes and shell metacharacters", () => {
  assert.equal(typeCommand("hello"), "input text 'hello'");
  assert.deepEqual(typed("a b  c"), ["a b  c"]);
  const nasty = "$HOME;`id`\"q\"'x'\\n&|<>(){}[]*?!~#";
  assert.deepEqual(typed(nasty), [nasty]);
  assert.deepEqual(typed("; reboot"), ["; reboot"]);
  assert.deepEqual(typed("$(reboot)"), ["$(reboot)"]);
  assert.deepEqual(typed("-d 5"), ["-d 5"]);
});

test("`%s` is typed as written, never as the space `input text` makes of it", () => {
  // No piece holds `%s`, and the pieces together are the text.
  for (const text of ["100%sure", "%s", "%%s%s", "a%", "s%s%", "%S stays"]) {
    const pieces = typed(text);
    assert.equal(pieces.join(""), text);
    for (const piece of pieces) assert.doesNotMatch(piece, /%s/, text);
  }
  assert.equal(typeCommand("100%sure"), "input text '100%' && input text 'sure'");
});

test("property: typed text arrives whole and without `%s` in any piece", () => {
  fc.assert(
    fc.property(
      fc.string({
        unit: fc.constantFrom("%", "s", "'", " ", "a", "\\", "$", '"', ";"),
        minLength: 1,
        maxLength: 40,
      }),
      (text) => {
        const pieces = typed(text);
        assert.equal(pieces.join(""), text);
        assert.ok(pieces.every((piece) => !piece.includes("%s")));
      },
    ),
    { numRuns: 60 },
  );
});

test("text beyond printable ASCII is refused with its own code", () => {
  for (const text of ["Grüße", "naïve", "😀", "tab\there", "line\nbreak", "\u007f"])
    assert.throws(() => typeCommand(text), refused("DEVICE_TEXT_UNSUPPORTED"), text);
  assert.throws(() => typeCommand(""), refused("DEVICE_INPUT_INVALID", "text"));
  assert.throws(() => typeCommand("x".repeat(1001)), refused("DEVICE_INPUT_INVALID"));
  assert.throws(() => typeCommand(undefined), refused("DEVICE_INPUT_INVALID"));
  assert.equal(typeCommand("x".repeat(1000)).length, 1013);
});

test("keys come from a fixed list of names", () => {
  assert.deepEqual(KEY_NAMES, [
    "back",
    "home",
    "enter",
    "tab",
    "delete",
    "app_switch",
    "menu",
    "power",
    "volume_up",
    "volume_down",
    "dpad_up",
    "dpad_down",
    "dpad_left",
    "dpad_right",
    "dpad_center",
    "escape",
    "search",
  ]);
  for (const code of Object.values(KEYS)) assert.match(code, /^KEYCODE_[A-Z_]+$/);
  assert.equal(keyCommand("back"), "input keyevent KEYCODE_BACK");
  assert.equal(
    keyCommand("delete", 3),
    "input keyevent KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL",
  );
  for (const name of ["KEYCODE_BACK", "4", "back; reboot", "toString", "", undefined])
    assert.throws(() => keyCommand(name), refused("DEVICE_INPUT_INVALID", "key"));
  for (const count of [0, 51, 1.5, "2"])
    assert.throws(() => keyCommand("back", count), refused("DEVICE_INPUT_INVALID"));
});

test("taps and swipes take whole coordinates on the screen", () => {
  assert.equal(tapCommand(point(360, 800)), "input tap 360 800");
  assert.equal(longPressCommand(point(10, 20)), "input swipe 10 20 10 20 800");
  assert.equal(swipeCommand(point(1, 2), point(3, 4)), "input swipe 1 2 3 4 300");
  assert.equal(swipeCommand(point(1, 2), point(3, 4), 50), "input swipe 1 2 3 4 50");
  for (const [x, y] of [
    [-1, 5],
    [5, 10001],
    [1.5, 2],
    ["1", 2],
    [1, undefined],
    [NaN, 1],
  ])
    assert.throws(() => point(x, y), refused("DEVICE_INPUT_INVALID", "coordinates"));
  for (const ms of [49, 5001, 1.5, "300"])
    assert.throws(
      () => swipeCommand(point(1, 2), point(3, 4), ms),
      refused("DEVICE_INPUT_INVALID", "durationMs"),
    );
});

test("a scroll moves the finger against the direction, in the middle of the screen", () => {
  const screen = { width: 720, height: 1600 };
  assert.deepEqual(scrollPoints("down", screen), [
    { x: 360, y: 1200 },
    { x: 360, y: 400 },
  ]);
  assert.deepEqual(scrollPoints("up", screen), [
    { x: 360, y: 400 },
    { x: 360, y: 1200 },
  ]);
  assert.deepEqual(scrollPoints("right", screen), [
    { x: 540, y: 800 },
    { x: 180, y: 800 },
  ]);
  assert.deepEqual(scrollPoints("left", screen), [
    { x: 180, y: 800 },
    { x: 540, y: 800 },
  ]);
  assert.throws(() => scrollPoints("sideways", screen), refused("DEVICE_INPUT_INVALID"));
});

test("packages, activities, device paths, URLs and log filters are narrow", () => {
  for (const name of ["com.example.app", "org.mozilla.firefox_beta", "a.b"])
    assert.equal(packageName(name), name);
  for (const name of [
    "",
    "app",
    "-r",
    "com.example;reboot",
    "com.example app",
    "com..example",
    "com.example.",
    ".com.example",
    "x".repeat(201) + ".a",
    7,
  ])
    assert.throws(() => packageName(name), refused("DEVICE_INPUT_INVALID", "package"));
  for (const name of [".Main", "com.example.app.MainActivity", "Main$Inner"])
    assert.equal(activityName(name), name);
  for (const name of ["", "-n", "a/b", "Main Activity", "..Main", "Main;id"])
    assert.throws(() => activityName(name), refused("DEVICE_INPUT_INVALID", "activity"));
  for (const file of ["/sdcard/Download/a b.txt", "/data/local/tmp/x'y"])
    assert.equal(devicePath(file), file);
  for (const file of [
    "",
    "sdcard/a",
    "-a",
    "/sdcard/",
    "/sdcard/../data/x",
    "/sdcard/a\nb",
    "/x".repeat(600),
  ])
    assert.throws(() => devicePath(file), refused("DEVICE_INPUT_INVALID", "devicePath"));
  for (const link of ["https://example.com/?a=1&b=$HOME;id", "myapp://open/7", "tel:+49"])
    assert.equal(url(link), link);
  for (const link of [
    "",
    "example.com",
    "-d",
    "https://a b",
    "https://a\nb",
    "://x",
    "h:",
  ])
    assert.throws(() => url(link), refused("DEVICE_INPUT_INVALID", "url"));
  assert.equal(logTag("ActivityManager"), "ActivityManager");
  for (const tag of ["", "a b", "tag:I", "*", "x".repeat(65), "-s"])
    assert.throws(() => logTag(tag), refused("DEVICE_INPUT_INVALID", "tag"), tag);
  assert.equal(logPriority("W"), "W");
  for (const priority of ["w", "S", "*", "", "WARN"])
    assert.throws(() => logPriority(priority), refused("DEVICE_INPUT_INVALID"));
});

test("details and output are bounded", () => {
  assert.equal(brief("  adb: error\u0000 here\n"), "adb: error  here");
  assert.equal(brief("x".repeat(500)).length, 402);
  assert.equal(brief(undefined), "");
  assert.deepEqual(bounded("short", 10), { text: "short", truncated: false });
  assert.deepEqual(bounded("0123456789", 4), { text: "0123", truncated: true });
  assert.deepEqual(bounded("0123456789", 4, { tail: true }), {
    text: "6789",
    truncated: true,
  });
  // A character cut in half is dropped, never shown as a replacement character.
  const cut = bounded("ää", 3);
  assert.deepEqual(cut, { text: "ä", truncated: true });
  assert.deepEqual(bounded("ää", 3, { tail: true }), { text: "ä", truncated: true });
});
