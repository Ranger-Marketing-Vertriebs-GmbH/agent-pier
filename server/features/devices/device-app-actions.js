import fs from "node:fs";
import path from "node:path";
import {
  activityName,
  bounded,
  brief,
  commandFailed,
  devicePath,
  invalid,
  logPriority,
  logTag,
  packageName,
  shellWord,
  url,
} from "./device-input.js";
import { refusal } from "./device-registry.js";
import { copyIn, copyOut, destination } from "./host-area.js";

/*
 * The actions of device-actions.js for apps, files, logs and the device's shell.
 * Each is `(input, call) -> result`.
 *
 *   install     { device, path }                 an APK of the caller's area
 *   push        { device, path, devicePath }     a file of the area to the device
 *   pull        { device, devicePath, path }     a file of the device into the area
 *   app_launch  { device, package, activity? }
 *   app_stop    { device, package }
 *   apps        { device, all? }                 third-party packages, or all
 *   open_url    { device, url }
 *   logs        { device, lines?, package?, tag?, priority? }
 *   shell       { device, command, timeoutMs? }  inside the device, never on the host
 *
 * A host `path` is absolute or relative to the caller's area and must lie in it
 * (host-area.js). adb reads and writes a private copy, so no path of the area and
 * nothing a caller typed ever reaches adb as a host path. A device path is one
 * argument of adb (push, pull) or one quoted word of the device's shell.
 */
const area = async (call) => {
  const folder = await call.area();
  if (!folder) throw refusal("DEVICE_PATH_OUTSIDE", 403);
  return folder;
};
// adb names the private copy in what it prints; a caller never learns that path.
const scrubbed = (answer, folder) => ({
  stderr: String(answer.stderr ?? "").replaceAll(`${folder}${path.sep}`, ""),
  stdout: String(answer.stdout ?? "").replaceAll(`${folder}${path.sep}`, ""),
});
const hostPath = (value) => {
  if (typeof value !== "string" || !value) throw invalid("path");
  return value;
};
const whole = (value, name, min, max, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(name);
  return value;
};

/**
 * Runs `work(signal)` while watching `file`: once it is larger than `limit` the
 * signal aborts and DEVICE_FILE_TOO_LARGE is thrown, so a file that grew after its
 * size was read never fills the disk.
 */
async function capped(file, limit, outer, work) {
  const controller = new AbortController();
  let over = false;
  const watch = setInterval(() => {
    try {
      if (fs.statSync(file).size > limit) {
        over = true;
        controller.abort();
      }
    } catch {
      // Not there yet.
    }
  }, 100);
  try {
    return await work(AbortSignal.any([outer, controller.signal]));
  } catch (error) {
    throw over ? refusal("DEVICE_FILE_TOO_LARGE", 400, { limit }) : error;
  } finally {
    clearInterval(watch);
  }
}

/**
 * The private copy of the file `requested` of the caller's area that adb reads,
 * below `folder`: `{ file, within, bytes, name }`. It has the file's own name in a
 * folder of its own (`within`), so adb names it as the caller did, and a file pushed
 * onto a folder of the device keeps that name.
 */
async function privateCopy(call, folder, requested) {
  const first = path.join(folder, "payload");
  const { bytes, name } = await copyIn({
    area: await area(call),
    requested,
    target: first,
    maxBytes: call.limits.pushBytes,
    protectedRoots: call.protectedRoots,
  });
  const within = path.join(folder, "named");
  fs.mkdirSync(within, { mode: 0o700 });
  const file = path.join(within, name);
  fs.renameSync(first, file);
  return { file, within, bytes, name };
}

export const appActions = {
  async install(input, call) {
    const { id } = call.device(input.device);
    const requested = hostPath(input.path);
    return call.actions.staged(async (folder) => {
      const { file, within, bytes, name } = await privateCopy(call, folder, requested);
      // adb installs only a file whose name ends in `.apk`.
      if (!/\.apk$/i.test(name)) throw invalid("path");
      const answer = await call.adb(id, ["install", "-r", file], {
        timeoutMs: 120000,
        maxBytes: call.limits.outputBytes,
      });
      if (answer.code !== 0 || !/^Success\b/m.test(answer.stdout))
        throw commandFailed(scrubbed(answer, within), "The installation failed.");
      return { installed: name, bytes };
    });
  },
  async push(input, call) {
    const { id } = call.device(input.device);
    const requested = hostPath(input.path);
    const remote = devicePath(input.devicePath);
    return call.actions.staged(async (folder) => {
      const { file, within, bytes } = await privateCopy(call, folder, requested);
      const answer = await call.adb(id, ["push", file, remote], {
        timeoutMs: 120000,
        maxBytes: call.limits.outputBytes,
      });
      if (answer.code !== 0)
        throw commandFailed(scrubbed(answer, within), "The copy failed.");
      return { pushed: remote, bytes };
    });
  },
  async pull(input, call) {
    const { id } = call.device(input.device);
    const remote = devicePath(input.devicePath);
    const requested = hostPath(input.path);
    const into = await area(call);
    const limit = call.limits.pullBytes;
    // Refused before the device is asked: a place outside the area.
    destination(into, requested, { protectedRoots: call.protectedRoots });
    const found = await call.shell(id, `stat -L -c '%F|%s' ${shellWord(remote)}`);
    const [kind, size] = found.stdout.trim().split("|");
    if (found.code !== 0 || kind !== "regular file")
      throw refusal("DEVICE_FILE_NOT_FOUND", 404, { detail: brief(found.stderr) });
    if (!(Number(size) <= limit)) throw refusal("DEVICE_FILE_TOO_LARGE", 400, { limit });
    return call.actions.staged(async (folder) => {
      const staged = path.join(folder, "payload");
      const answer = await capped(staged, limit, call.signal, (signal) =>
        call.adb(id, ["pull", remote, staged], {
          timeoutMs: 120000,
          maxBytes: call.limits.outputBytes,
          signal,
        }),
      );
      if (answer.code !== 0)
        throw commandFailed(scrubbed(answer, folder), "The copy failed.");
      const { bytes, name } = await copyOut({
        area: into,
        requested,
        source: staged,
        maxBytes: limit,
        protectedRoots: call.protectedRoots,
      });
      return { pulled: name, bytes };
    });
  },

  async app_launch(input, call) {
    const { id } = call.device(input.device);
    const name = packageName(input.package);
    let component;
    if (input.activity !== undefined)
      component = `${name}/${activityName(input.activity)}`;
    else {
      const found = await call.shell(
        id,
        `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shellWord(name)}`,
      );
      // The last line names the activity, or says that there is none.
      component = found.stdout.trim().split("\n").at(-1)?.trim() ?? "";
      if (
        found.code !== 0 ||
        !component.startsWith(`${name}/`) ||
        !/^[\w.]+\/[\w.$]+$/.test(component)
      )
        throw commandFailed(
          { stdout: found.code === 0 ? "" : found.stderr },
          "The app is not installed or has no launcher activity.",
        );
    }
    const answer = await call.shell(id, `am start -n ${shellWord(component)}`);
    if (answer.code !== 0 || /^Error\b/m.test(answer.stderr)) throw commandFailed(answer);
    return { launched: component };
  },
  async app_stop(input, call) {
    const { id } = call.device(input.device);
    const name = packageName(input.package);
    const answer = await call.shell(id, `am force-stop ${shellWord(name)}`);
    if (answer.code !== 0) throw commandFailed(answer);
    return { stopped: name };
  },
  async apps(input, call) {
    const { id } = call.device(input.device);
    if (input.all !== undefined && typeof input.all !== "boolean") throw invalid("all");
    const answer = await call.shell(id, `pm list packages${input.all ? "" : " -3"}`, {
      maxBytes: 2 ** 20,
    });
    if (answer.code !== 0) throw commandFailed(answer);
    const names = answer.stdout
      .split("\n")
      .map((entry) => /^package:(\S{1,200})$/.exec(entry.trim())?.[1])
      .filter(Boolean)
      .sort();
    const packages = names.slice(0, call.limits.apps);
    const cut = answer.truncated || packages.length < names.length;
    return {
      packages,
      total: names.length,
      truncated: cut,
      ...(cut && { note: `Showing the first ${packages.length} packages.` }),
    };
  },
  async open_url(input, call) {
    const { id } = call.device(input.device);
    const target = url(input.url);
    const answer = await call.shell(
      id,
      `am start -a android.intent.action.VIEW -d ${shellWord(target)}`,
    );
    if (answer.code !== 0 || /^Error\b/m.test(answer.stderr)) throw commandFailed(answer);
    return { opened: target };
  },
  async logs(input, call) {
    const { id } = call.device(input.device);
    const { logLines, logLinesMax, outputBytes } = call.limits;
    const lines = whole(input.lines, "lines", 1, logLinesMax, logLines);
    const tag = input.tag === undefined ? null : logTag(input.tag);
    const priority = input.priority === undefined ? null : logPriority(input.priority);
    const name = input.package === undefined ? null : packageName(input.package);
    let pid = null;
    if (name) {
      const found = await call.shell(id, `pidof -s ${shellWord(name)}`);
      pid = /^\d+$/.exec(found.stdout.trim())?.[0] ?? null;
      if (!pid) return { lines: [], truncated: false, note: `${name} is not running.` };
    }
    // logcat takes its last lines first and filters them afterwards, so with a
    // filter more are read than are wanted.
    const filter = tag
      ? ` -s ${shellWord(`${tag}:${priority ?? "V"}`)}`
      : priority
        ? ` ${shellWord(`*:${priority}`)}`
        : "";
    const read = filter ? 5000 : lines;
    const answer = await call.shell(
      id,
      `logcat -d -v threadtime -t ${read}${pid ? ` --pid=${pid}` : ""}${filter}`,
      { maxBytes: 2 * 2 ** 20 },
    );
    if (answer.code !== 0 && !answer.truncated) throw commandFailed(answer);
    const all = answer.stdout
      .split("\n")
      .filter((entry) => entry && !entry.startsWith("--------- beginning of"));
    // The latest lines count; an entry cut by the byte limit of adb is dropped.
    const latest = (answer.truncated ? all.slice(0, -1) : all).slice(-lines);
    const cut = bounded(latest.join("\n"), outputBytes, { tail: true });
    const kept = cut.truncated ? cut.text.split("\n").slice(1) : latest;
    return {
      lines: kept,
      truncated: cut.truncated,
      ...(cut.truncated && { note: `Showing the last ${kept.length} lines.` }),
    };
  },
  async shell(input, call) {
    const { id } = call.device(input.device);
    const { command } = input;
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 8000 ||
      command.includes("\0") ||
      // adb would read a leading dash as an option of its own `shell`.
      /^\s*-/.test(command)
    )
      throw invalid("command");
    const { shellTimeoutMs, shellTimeoutMaxMs, outputBytes, errorBytes } = call.limits;
    const timeoutMs = whole(
      input.timeoutMs,
      "timeoutMs",
      1000,
      shellTimeoutMaxMs,
      shellTimeoutMs,
    );
    // One argument after `shell`: adb hands it to the device's shell as it is.
    const answer = await call.adb(id, ["shell", command], {
      timeoutMs,
      maxBytes: outputBytes,
    });
    const errors = bounded(answer.stderr, errorBytes);
    const truncated = answer.truncated || errors.truncated;
    return {
      // Null when the command was ended because its output reached the limit.
      exitCode: answer.code,
      stdout: answer.stdout,
      stderr: errors.text,
      truncated,
      ...(truncated && {
        note: `The output was cut at ${outputBytes} bytes${answer.truncated ? " and the command was ended" : ""}.`,
      }),
    };
  },
};
