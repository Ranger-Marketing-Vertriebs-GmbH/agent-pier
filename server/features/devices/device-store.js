import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { isDeviceId } from "./avd-files.js";

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

export class DeviceStore {
  /** `write(file, value)` writes the file atomically; tests replace it. */
  constructor({ dataDir, now = Date.now, write = writePrivate }) {
    Object.assign(this, { now, write });
    this.file = path.join(dataDir, "devices", "devices.json");
    let stored = null;
    try {
      stored = readJSON(this.file, null);
    } catch {
      // A damaged file reads as no devices.
    }
    this.devices = Array.isArray(stored?.devices) ? stored.devices.filter(valid) : [];
  }
  // The file is written first: a failed write changes nothing in memory either.
  #save(devices) {
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
