import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manualTimers } from "./manual-timers.js";
import { memoryDeviceSource } from "./memory-device-source.js";
import { DeviceService } from "../../server/features/devices/device-service.js";

/** The pinned image of the fixture's SDK. */
export const fixtureImage = "android-36-google_apis-r7";
export const owner = { kind: "owner" };
export const session = (id) => ({ kind: "session", id });
export const agent = (id) => ({ kind: "agent", id });

/**
 * A DeviceService on a source that lives in memory, with a manual clock, in its own
 * data folder (or in `dataDir`, as another process on the same data): `service`,
 * `source`, `clock`, `sdk` (`reason` is what `available()` answers), `signals` (how
 * often the view changed, and the most devices that counted as running), `audited`,
 * `create(name, creator)`, `state(id)` and `settled(promise)`.
 */
export function fixture(t, { dataDir, ...options } = {}) {
  const folder = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "device-service-"));
  if (!dataDir) t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const clock = manualTimers();
  const source = memoryDeviceSource({ image: fixtureImage });
  const sdk = {
    reason: null,
    available: () => sdk.reason,
    manifest: { image: { id: fixtureImage } },
  };
  const signals = { count: 0, peak: 0 };
  const audited = [];
  const service = new DeviceService({
    dataDir: folder,
    sdk,
    sources: { emulator: source },
    now: clock.now,
    timers: clock.timers,
    changed: () => {
      signals.count++;
      signals.peak = Math.max(signals.peak, service.view().counts.running);
    },
    audit: (entry) => audited.push(entry),
    ...options,
  });
  const create = (name, creator = { ...owner, name: "Owner" }) =>
    service.create({ name, creator });
  const state = (id) => service.device(id).state;
  // Whether a promise has settled by now.
  const settled = async (promise) => {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    await clock.settle();
    return done;
  };
  return {
    dataDir: folder,
    clock,
    source,
    sdk,
    service,
    signals,
    audited,
    create,
    state,
    settled,
  };
}
