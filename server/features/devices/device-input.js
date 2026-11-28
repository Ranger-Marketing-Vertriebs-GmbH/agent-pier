import { refusal } from "./device-registry.js";

/*
 * What a tool call may hand to a device, checked and turned into words of the
 * device's shell. Nothing here runs anything, and no host shell is involved at any
 * point: AgentPier starts adb with an argument array, and adb hands the one string
 * after `shell` to the shell inside the device. So whatever comes from a caller is
 * either checked against a narrow pattern or quoted as one word (`shellWord`).
 */

/** A refusal for a malformed argument; `detail` names it in a few words. */
export const invalid = (detail) => refusal("DEVICE_INPUT_INVALID", 400, { detail });

const control = /[\u0000-\u001f\u007f]/;
const text = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** `value` as one word of the device's shell: in single quotes, `'` as `'\''`. */
export function shellWord(value) {
  if (typeof value !== "string" || value.includes("\0")) throw invalid("text");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The keys `device_key` knows, by the name a caller gives. */
export const KEYS = Object.freeze({
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  delete: "KEYCODE_DEL",
  app_switch: "KEYCODE_APP_SWITCH",
  menu: "KEYCODE_MENU",
  power: "KEYCODE_POWER",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  dpad_up: "KEYCODE_DPAD_UP",
  dpad_down: "KEYCODE_DPAD_DOWN",
  dpad_left: "KEYCODE_DPAD_LEFT",
  dpad_right: "KEYCODE_DPAD_RIGHT",
  dpad_center: "KEYCODE_DPAD_CENTER",
  escape: "KEYCODE_ESCAPE",
  search: "KEYCODE_SEARCH",
});
export const KEY_NAMES = Object.freeze(Object.keys(KEYS));
/** How often one call may press a key, and how long a typed text may be. */
export const MAX_KEY_COUNT = 50;
export const MAX_TEXT = 1000;

/** The shell command that presses key `name` `count` times. */
export function keyCommand(name, count = 1) {
  if (!Object.hasOwn(KEYS, name)) throw invalid("key");
  if (!Number.isInteger(count) || count < 1 || count > MAX_KEY_COUNT)
    throw invalid("count");
  return `input keyevent ${Array(count).fill(KEYS[name]).join(" ")}`;
}

/**
 * The shell command that types `value`. Only printable ASCII (space to `~`) can be
 * typed: `input text` sends key events, and the device's key map has none for other
 * characters (DEVICE_TEXT_UNSUPPORTED). `input text` reads `%s` as a space, so the
 * text is typed in pieces that never contain `%s`; everything else is literal once
 * it is one quoted word.
 */
export function typeCommand(value) {
  if (!text(value, MAX_TEXT)) throw invalid("text");
  if (/[^ -~]/.test(value)) throw refusal("DEVICE_TEXT_UNSUPPORTED", 400);
  return value
    .split(/(?<=%)(?=s)/)
    .map((piece) => `input text ${shellWord(piece)}`)
    .join(" && ");
}

/** Whether `value` is a coordinate a tap or swipe may name: a whole number from 0 to 10000. */
export const coordinate = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 10000;
/** `{ x, y }` as checked screen coordinates. */
export function point(x, y) {
  if (!coordinate(x) || !coordinate(y)) throw invalid("coordinates");
  return { x, y };
}
export const tapCommand = ({ x, y }) => `input tap ${x} ${y}`;
/** A long press is a swipe that does not move. */
export const longPressCommand = ({ x, y }, ms = 800) =>
  `input swipe ${x} ${y} ${x} ${y} ${ms}`;
export function swipeCommand(from, to, ms = 300) {
  if (!Number.isInteger(ms) || ms < 50 || ms > 5000) throw invalid("durationMs");
  return `input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${ms}`;
}

export const SCROLLS = Object.freeze(["down", "up", "left", "right"]);
/**
 * The swipe that scrolls a screen of `width` by `height` towards `direction`: to
 * see what is further down, the finger moves up, through the middle half of the
 * screen.
 */
export function scrollPoints(direction, { width, height }) {
  const [cx, cy] = [Math.round(width / 2), Math.round(height / 2)];
  const [dx, dy] = [Math.round(width / 4), Math.round(height / 4)];
  const moves = {
    down: [point(cx, cy + dy), point(cx, cy - dy)],
    up: [point(cx, cy - dy), point(cx, cy + dy)],
    right: [point(cx + dx, cy), point(cx - dx, cy)],
    left: [point(cx - dx, cy), point(cx + dx, cy)],
  };
  if (!Object.hasOwn(moves, direction)) throw invalid("scroll");
  return moves[direction];
}

/** An Android package name, as `pm` lists it. */
export function packageName(value) {
  if (!text(value, 200) || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value))
    throw invalid("package");
  return value;
}
/** An activity class, absolute or relative to its package (`.Main`). */
export function activityName(value) {
  if (!text(value, 300) || !/^\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value))
    throw invalid("activity");
  return value;
}
/**
 * A file on the device: an absolute path without control characters. It starts with
 * `/`, so adb never reads it as an option.
 */
export function devicePath(value) {
  if (
    !text(value, 1024) ||
    !value.startsWith("/") ||
    control.test(value) ||
    value.endsWith("/") ||
    value.split("/").includes("..")
  )
    throw invalid("devicePath");
  return value;
}
/** A URL with a scheme (http, https or an app's own), without spaces. */
export function url(value) {
  if (
    !text(value, 2048) ||
    control.test(value) ||
    /\s/.test(value) ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:./.test(value)
  )
    throw invalid("url");
  return value;
}
/** A logcat tag and priority, as words logcat's filter cannot misread. */
export function logTag(value) {
  if (!text(value, 64) || !/^[A-Za-z0-9_][A-Za-z0-9_.$-]*$/.test(value))
    throw invalid("tag");
  return value;
}
export const LOG_PRIORITIES = Object.freeze(["V", "D", "I", "W", "E", "F"]);
export function logPriority(value) {
  if (!LOG_PRIORITIES.includes(value)) throw invalid("priority");
  return value;
}

/** At most `max` characters of adb's or the device's words, for a refusal's detail. */
export function brief(value, max = 400) {
  const flat = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)} …` : flat;
}

/** A refusal of the device or of adb, with a short `detail` of what it said. */
export const commandFailed = (answer, fallback = "") =>
  refusal("DEVICE_COMMAND_FAILED", 409, {
    detail: brief(answer?.stderr || answer?.stdout || fallback),
  });

/** `value` cut to `maxBytes` of UTF-8 at a character boundary: `{ text, truncated }`. */
export function bounded(value, maxBytes, { tail = false } = {}) {
  const bytes = Buffer.from(String(value ?? ""));
  if (bytes.length <= maxBytes) return { text: bytes.toString(), truncated: false };
  const cut = tail
    ? bytes.subarray(bytes.length - maxBytes)
    : bytes.subarray(0, maxBytes);
  // A character cut in half at the edge shows as U+FFFD; drop it.
  const text = cut.toString().replace(tail ? /^�+/ : /�+$/, "");
  return { text, truncated: true };
}
