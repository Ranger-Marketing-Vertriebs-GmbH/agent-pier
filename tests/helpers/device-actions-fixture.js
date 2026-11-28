import fs from "node:fs";
import path from "node:path";
import {
  ACTION_LIMITS,
  DeviceActions,
} from "../../server/features/devices/device-actions.js";
import { fixture, owner, session } from "./device-service-fixture.js";

/** A PNG header of `width` by `height`, as `screencap -p` begins. */
export function pngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/**
 * DeviceActions on the device service of device-service-fixture.js (a source in
 * memory), for the session `s1`:
 *
 * - `actions`, and `run(action, input, context)` as session `s1`, which may create
 *   devices when `allow.create` is true and whose area is `area` (a folder with
 *   `build/app.apk`)
 * - `grant(sessionId, deviceId, manage)`: what the owner assigned
 * - `owned(name)`: a device of the owner's, assigned to `s1`
 * - `adb`: the adb calls so far, `[{ id, args, options }]`; `answers(handler)` sets
 *   what the device answers (`(args, options, record) => result | undefined`)
 * - everything of the service fixture (`service`, `source`, `clock`, `create`, …)
 */
export function actionsFixture(t, { limits, callTimeoutMs, ...options } = {}) {
  const f = fixture(t, options);
  const granted = new Map();
  f.service.registerGrants("session", (id) => granted.get(id) ?? []);
  const actions = new DeviceActions({
    devices: f.service,
    dataDir: f.dataDir,
    ...(callTimeoutMs && { callTimeoutMs }),
    limits: { ...ACTION_LIMITS, ...limits },
  });
  const area = path.join(f.dataDir, "..", `area-${path.basename(f.dataDir)}`);
  fs.mkdirSync(path.join(area, "build"), { recursive: true });
  fs.writeFileSync(path.join(area, "build", "app.apk"), "apk bytes");
  t.after(() => fs.rmSync(area, { recursive: true, force: true }));
  const adb = [];
  let handler = () => undefined;
  f.source.answer = (record, args, options) => {
    adb.push({ id: record.id, args, options });
    return handler(args, options, record);
  };
  const allow = { create: false };
  const caller = { ...session("s1"), name: "web checkout" };
  const context = (extra = {}) => ({
    caller,
    canCreate: () => allow.create,
    area: () => area,
    ...extra,
  });
  return {
    ...f,
    actions,
    area,
    adb,
    allow,
    caller,
    context,
    transfers: path.join(f.dataDir, "devices", "run", "transfers"),
    answers: (next) => (handler = next),
    run: (action, input, extra) => actions.run(action, input, context(extra)),
    grant(sessionId, deviceId, manage = false) {
      granted.set(sessionId, [
        ...(granted.get(sessionId) ?? []).filter((entry) => entry.deviceId !== deviceId),
        { deviceId, manage },
      ]);
    },
    revoke: (sessionId) => granted.delete(sessionId),
    async owned(name = "Pixel", manage = false) {
      const device = await f.create(name, { ...owner, id: "owner", name: "" });
      this.grant("s1", device.id, manage);
      return device;
    },
  };
}

/** Matches a refusal by its code and, when given, its status and detail. */
export const refused = (code, status, detail) => (error) =>
  error.code === code &&
  (status === undefined || error.status === status) &&
  (detail === undefined ||
    (detail instanceof RegExp ? detail.test(error.detail) : error.detail === detail));
