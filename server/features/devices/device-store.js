import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { avdImage, isDeviceId, listAvds, unknownImage } from "./avd-files.js";

/*
 * The device records, in `<data>/devices/devices.json` (`{ version: 1, devices }`),
 * a feature-owned file that is not part of a backup. A record is
 *
 *   { id, name, source, creator: { kind, id, name }, image, provisioned,
 *     createdAt, lastUsedAt, resetAt }
 *
 * and holds no runtime state: whether a device runs is the service's knowledge
 * (device-service.js). `image` is the system image the device was made with or last
 * reset to; `provisioned` says that its first-boot steps ran.
 *
 * A file that cannot be read as that (cut off, hand-edited, with records that are
 * none) is never simply replaced: every device is a folder of several gigabytes
 * that only its record makes visible and deletable. The file is first kept aside as
 * `devices.json.damaged-<time>`, and every device folder below `<data>/devices/avd`
 * that has no record left gets one again: named "Recovered device <n>", created by
 * the owner, on the image its `config.ini` names ("unknown" when it names none; a
 * reset moves such a device to the pinned image). A missing file is no damage.
 */
const creators = ["owner", "agent", "session"];
const changeable = ["name", "image", "provisioned", "lastUsedAt", "resetAt"];
const refusal = (code, status) => Object.assign(Error(code), { code, status });
const text = (value) => typeof value === "string" && value.length > 0;

/** The name as stored: trimmed, 1 to 40 characters, no control characters. */
export function deviceName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(name))
    throw refusal("DEVICE_NAME_INVALID", 400);
  return name;
}

const valid = (record) =>
  isDeviceId(record?.id) &&
  text(record.name) &&
  text(record.source) &&
  text(record.image) &&
  creators.includes(record.creator?.kind);

// Copies the damaged `file` to `target`, for the owner only; never over another.
function copyAside(file, target) {
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}

export class DeviceStore {
  /**
   * `write(file, value)` writes the file atomically, `keepAside(file, target)`
   * copies a damaged file and `log(line)` hears of it; tests replace them.
   */
  constructor({
    dataDir,
    now = Date.now,
    write = writePrivate,
    keepAside = copyAside,
    log = console.warn,
  }) {
    Object.assign(this, { now, write, keepAside, log });
    this.file = path.join(dataDir, "devices", "devices.json");
    this.avd = path.join(dataDir, "devices", "avd");
    // A damaged file that is not kept aside yet: nothing is written over it.
    this.damaged = false;
    let stored = null;
    try {
      stored = readJSON(this.file, null);
    } catch {
      this.damaged = true;
    }
    const listed = Array.isArray(stored?.devices) ? stored.devices : null;
    this.devices = (listed ?? []).filter(valid);
    if (!listed && fs.existsSync(this.file)) this.damaged = true;
    if (this.damaged || this.devices.length !== (listed?.length ?? 0)) this.#recover();
  }
  #aside() {
    for (let time = this.now(); ; time++) {
      const target = `${this.file}.damaged-${time}`;
      try {
        this.keepAside(this.file, target);
        this.damaged = false;
        return path.basename(target);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
  }
  // What is left of a damaged file, and a record for every device folder without one.
  #recover() {
    this.damaged = true;
    const paths = { avd: this.avd };
    const known = new Set(this.devices.map((device) => device.id));
    const devices = [...this.devices];
    let number = 0;
    for (const id of listAvds(paths)) {
      if (known.has(id)) continue;
      let name;
      do name = `Recovered device ${++number}`;
      while (devices.some((device) => device.name.toLowerCase() === name.toLowerCase()));
      devices.push({
        id,
        name,
        source: "emulator",
        creator: { kind: "owner", id: "owner", name: "" },
        image: avdImage(paths, id) ?? unknownImage,
        // Its first-boot steps run again; they change nothing when they ran before.
        provisioned: false,
        createdAt: this.now(),
        lastUsedAt: null,
        resetAt: null,
      });
    }
    const found = devices.length - this.devices.length;
    this.devices = devices;
    let kept = null;
    try {
      kept = this.#aside();
      this.write(this.file, { version: 1, devices });
    } catch {
      // Told below; while the copy is missing, every later write tries it again.
    }
    this.log(
      `Android devices: devices.json was damaged and ${
        kept ? `is kept as ${kept}` : "could not be kept aside (nothing overwrites it)"
      }; ${found} device(s) were recovered from their folders.`,
    );
  }
  // The file is written first: a failed write changes nothing in memory either.
  #save(devices) {
    if (this.damaged) this.#aside();
    this.write(this.file, { version: 1, devices });
    this.devices = devices;
  }
  #taken(name, except) {
    const key = name.toLowerCase();
    return this.devices.some(
      (device) => device.id !== except && device.name.toLowerCase() === key,
    );
  }
  list() {
    return this.devices.map((device) => structuredClone(device));
  }
  /** The record of `id`. Throws DEVICE_NOT_FOUND (404). */
  get(id) {
    const found = this.devices.find((device) => device.id === id);
    if (!found) throw refusal("DEVICE_NOT_FOUND", 404);
    return structuredClone(found);
  }
  /**
   * Adds a device and returns its record. Throws DEVICE_NAME_INVALID (400) or
   * DEVICE_NAME_TAKEN (409, names are unique without regard to case).
   */
  add({ name, creator, image, source = "emulator" }) {
    const stored = deviceName(name);
    if (this.#taken(stored)) throw refusal("DEVICE_NAME_TAKEN", 409);
    if (!creators.includes(creator?.kind) || !text(image) || !text(source))
      throw TypeError("A device needs a creator, an image and a source.");
    let id;
    do id = `d-${randomBytes(6).toString("hex")}`;
    while (this.devices.some((device) => device.id === id));
    const record = {
      id,
      name: stored,
      source,
      creator: {
        kind: creator.kind,
        id: text(creator.id) ? creator.id : creator.kind,
        name: text(creator.name) ? creator.name : "",
      },
      image,
      provisioned: false,
      createdAt: this.now(),
      lastUsedAt: null,
      resetAt: null,
    };
    this.#save([...this.devices, record]);
    return structuredClone(record);
  }
  /** Changes `name`, `image`, `provisioned`, `lastUsedAt` or `resetAt` of a device. */
  patch(id, changes) {
    const current = this.get(id);
    const next = { ...current };
    for (const [key, value] of Object.entries(changes)) {
      if (!changeable.includes(key)) throw TypeError(`A device has no ${key} to change.`);
      next[key] = key === "name" ? deviceName(value) : value;
    }
    if (next.name !== current.name && this.#taken(next.name, id))
      throw refusal("DEVICE_NAME_TAKEN", 409);
    this.#save(this.devices.map((device) => (device.id === id ? next : device)));
    return structuredClone(next);
  }
  /** Removes the record of `id`. Throws DEVICE_NOT_FOUND (404). */
  remove(id) {
    this.get(id);
    this.#save(this.devices.filter((device) => device.id !== id));
  }
}
