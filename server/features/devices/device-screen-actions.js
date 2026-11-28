import {
  brief,
  commandFailed,
  invalid,
  keyCommand,
  longPressCommand,
  point,
  SCROLLS,
  scrollPoints,
  swipeCommand,
  tapCommand,
  typeCommand,
} from "./device-input.js";
import { refusal } from "./device-registry.js";
import { overview } from "./ui-overview.js";

/*
 * The actions of device-actions.js that list and manage devices and that look at
 * and operate a device's screen. Each is `(input, call) -> result`; `call` is the
 * one DeviceActions#run builds (the caller, its devices, adb on a device).
 *
 *   list        {}                              the caller's devices with their state
 *   create      { name }                        needs the caller's create permission
 *   start, stop { device }
 *   reset       { device }                      needs `manage` or the caller's own device
 *   delete      { device }                      the same
 *   screenshot  { device }                      { image: Buffer, mimeType, width, height }
 *   ui          { device }                      the numbered overview (ui-overview.js)
 *   tap         { device, element | x, y, longPress? }
 *   swipe       { device, scroll | x1, y1, x2, y2, durationMs? }
 *   key         { device, key, count? }         a name of KEYS
 *   type        { device, text }                printable ASCII only
 *
 * `device` is a device's id or its name.
 */
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A device as its user sees it in a result.
const summary = (caller, device) => ({
  id: device.id,
  name: device.name,
  state: device.state,
  // Created by this caller: it may reset and delete it without a grant.
  own: device.creator.kind === caller.kind && device.creator.id === caller.id,
  manage: !!device.manage,
  held: device.held,
  ...(device.operation && { operation: device.operation }),
  ...(device.failure && { failure: device.failure.code }),
});
// The device after an action. The caller may have lost it while the action ran (a
// grant taken away, a device deleted): DEVICE_FORBIDDEN or DEVICE_NOT_FOUND then.
const mine = (call, id) => summary(call.caller, call.device(id));
// A shell command of ours that must succeed.
async function command(call, id, text, options) {
  const answer = await call.shell(id, text, options);
  if (answer.code !== 0) throw commandFailed(answer);
  return answer;
}
const unavailable = (answer) =>
  refusal("DEVICE_SCREEN_UNAVAILABLE", 409, {
    detail: brief(typeof answer?.stdout === "string" ? answer.stdout : answer?.stderr),
  });

/** The size of the device's screen as the window manager has it now. */
async function screenSize(call, id) {
  const { stdout } = await command(call, id, "wm size");
  // An override, when there is one, is the size apps see; it is printed last.
  const sizes = [...stdout.matchAll(/size: (\d+)x(\d+)/g)];
  if (!sizes.length) throw commandFailed({ stdout });
  const [, width, height] = sizes.at(-1);
  return { width: Number(width), height: Number(height) };
}

export const screenActions = {
  async list(_input, call) {
    return {
      devices: call.devicesFor().map((device) => summary(call.caller, device)),
      canCreate: call.canCreate(),
    };
  },
  async create(input, call) {
    if (!call.canCreate()) throw refusal("DEVICE_CREATE_FORBIDDEN", 403);
    const { kind, id, name } = call.caller;
    const created = await call.devices.create({
      name: input.name,
      creator: { kind, id, name: typeof name === "string" ? name : "" },
    });
    return { device: mine(call, created.id) };
  },
  async start(input, call) {
    const { id } = call.device(input.device);
    await call.devices.startDevice(id, { caller: call.caller });
    return { device: mine(call, id) };
  },
  async stop(input, call) {
    const { id } = call.device(input.device);
    await call.devices.stopDevice(id, { caller: call.caller });
    return { device: mine(call, id) };
  },
  async reset(input, call) {
    const { id } = call.device(input.device);
    await call.devices.reset(id, { caller: call.caller });
    return { device: mine(call, id) };
  },
  async delete(input, call) {
    const { id, name } = call.device(input.device);
    await call.devices.remove(id, { caller: call.caller });
    return { deleted: { id, name } };
  },

  async screenshot(input, call) {
    const { id } = call.device(input.device);
    const answer = await call.adb(id, ["exec-out", "screencap", "-p"], {
      encoding: "buffer",
      maxBytes: call.limits.screenshotBytes,
      timeoutMs: 20000,
    });
    const image = answer.stdout;
    if (
      answer.code !== 0 ||
      answer.truncated ||
      image.length < 24 ||
      !image.subarray(0, 8).equals(png)
    )
      throw unavailable({ stderr: answer.stderr });
    // The IHDR chunk comes first: width and height at bytes 16 and 20.
    return {
      image,
      mimeType: "image/png",
      width: image.readUInt32BE(16),
      height: image.readUInt32BE(20),
    };
  },
  async ui(input, call) {
    const { id } = call.device(input.device);
    // To the terminal, so the dump needs no file on the device.
    const answer = await call.adb(id, ["exec-out", "uiautomator", "dump", "/dev/tty"], {
      maxBytes: 4 * 2 ** 20,
      timeoutMs: 30000,
    });
    const shown = answer.truncated ? null : overview(answer.stdout);
    if (!shown) throw unavailable(answer);
    const { targets, ...result } = shown;
    call.actions.remember(call.caller, id, targets);
    return result;
  },
  async tap(input, call) {
    const { id } = call.device(input.device);
    const byElement = input.element !== undefined;
    if (byElement === (input.x !== undefined || input.y !== undefined))
      throw invalid("element or x and y");
    if (byElement && !(Number.isInteger(input.element) && input.element > 0))
      throw invalid("element");
    // A number is looked up before anything starts: without a current overview the
    // device is not booted for it.
    const at = byElement
      ? call.actions.target(call.caller, id, input.element)
      : point(input.x, input.y);
    await command(call, id, input.longPress ? longPressCommand(at) : tapCommand(at));
    return { ...(input.longPress ? { longPressed: at } : { tapped: at }) };
  },
  async swipe(input, call) {
    const { id } = call.device(input.device);
    const coordinates = ["x1", "y1", "x2", "y2"].map((name) => input[name]);
    const given = coordinates.filter((value) => value !== undefined).length;
    if ((input.scroll !== undefined) === given > 0 || (given && given < 4))
      throw invalid("scroll or x1, y1, x2 and y2");
    const ms = input.durationMs ?? 300;
    // Everything is checked before the device is asked for its size.
    swipeCommand(point(0, 0), point(0, 0), ms);
    if (!given && !SCROLLS.includes(input.scroll)) throw invalid("scroll");
    const [from, to] = given
      ? [point(input.x1, input.y1), point(input.x2, input.y2)]
      : scrollPoints(input.scroll, await screenSize(call, id));
    await command(call, id, swipeCommand(from, to, ms), { timeoutMs: 15000 });
    return { swiped: { from, to } };
  },
  async key(input, call) {
    const { id } = call.device(input.device);
    const count = input.count ?? 1;
    await command(call, id, keyCommand(input.key, count), { timeoutMs: 30000 });
    return { pressed: input.key, count };
  },
  async type(input, call) {
    const { id } = call.device(input.device);
    await command(call, id, typeCommand(input.text), { timeoutMs: 60000 });
    return { typed: input.text.length };
  },
};
