import fs from "node:fs";
import path from "node:path";
import { isCodingCli } from "../clis/catalog.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { isDeviceId } from "./avd-files.js";
import { devicePaths } from "./device-paths.js";
import { refusal } from "./device-registry.js";
import { readGrants } from "./grant-file.js";

/*
 * Which devices the owner assigned to which coding session, and which sessions may
 * create devices: `<data>/devices/session-grants.json`,
 *
 *   { version: 1, sessions: { "<session id>": { createdAt, name, create,
 *     devices: [{ deviceId, manage }] } } }
 *
 * `manage` allows reset and delete; `create` allows creating devices and is off
 * unless the owner turns it on. A device a session created is its own without any
 * entry here (device-access.js).
 *
 * The device service asks this store without waiting (its permission check and its
 * view are synchronous), so the store reads a session's own file
 * (`<data>/sessions/<id>.json`) itself: an entry counts only while that file exists
 * and names the same `createdAt`. A removed session therefore has no grant from the
 * moment its file is gone, and `discard` only tidies the entry away. A change is
 * written to the file before it counts in memory, so the two never differ. Entries stay
 * through a stop and a reload of their session; whether a session may use devices
 * at that moment is the caller's question (`eligible`).
 *
 * `onChange()` hears every change (the wiring signals the live topics).
 */
const MAX_DEVICES = 20;
const sessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const invalid = () => refusal("DEVICE_ASSIGNMENT_INVALID", 400);
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const none = () => ({ devices: [], create: false });

/**
 * Whether `session` can be given devices at all: a running, interactive coding CLI
 * of the owner's. Never a sign-in, pipeline or imported session, and never one a
 * restricted user's agent started (`userAgent(assistantId)` says so).
 */
export function deviceEligible(session, { userAgent = () => false } = {}) {
  if (
    !session ||
    session.status !== "running" ||
    !isCodingCli(session.tool) ||
    session.purpose === "login" ||
    session.pipeline ||
    session.imported
  )
    return false;
  const starter = session.startedBy;
  if (!starter) return true;
  try {
    return starter.kind === "agent" && !userAgent(starter.assistantId);
  } catch {
    return false;
  }
}

export class SessionDeviceGrants {
  /** `now()` and `log(line)` are for a damaged file (grant-file.js); tests replace them. */
  constructor({ dataDir, now, log }) {
    this.file = path.join(devicePaths(dataDir).root, "session-grants.json");
    this.sessions = path.join(path.resolve(dataDir), "sessions");
    this.onChange = null;
    // A damaged file, and an entry of another shape, grant nothing; the file is
    // kept aside and logged, and the file is written anew from what counts.
    this.entries = readGrants(
      this.file,
      "sessions",
      (id, entry) =>
        sessionId.test(id) && plain(entry)
          ? {
              createdAt: entry.createdAt,
              name: typeof entry.name === "string" ? entry.name.slice(0, 200) : "",
              ...this.validate({ devices: entry.devices, create: entry.create }),
            }
          : null,
      { now, log, rewrite: (entries) => this.#store(entries) },
    );
  }
  // The file first, then what is known in memory: a change that cannot be stored
  // is no change, so nothing is taken away (or given) until the next start only.
  #store(entries) {
    if (entries.size) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writePrivate(this.file, { version: 1, sessions: Object.fromEntries(entries) });
    } else fs.rmSync(this.file, { force: true });
    this.entries = entries;
  }
  #announce() {
    try {
      this.onChange?.();
    } catch {
      console.error("AgentPier could not announce a session's device access.");
    }
  }
  // Applies `change(entries)` to a copy of the entries, stores it and announces it.
  #commit(change) {
    const next = new Map(this.entries);
    change(next);
    this.#store(next);
    this.#announce();
  }
  /**
   * `{ devices: [{ deviceId, manage }], create }` as given, or
   * DEVICE_ASSIGNMENT_INVALID (400): exactly these fields, at most 20 devices, each
   * once. Nothing at all (`undefined`) is no access.
   */
  validate(access) {
    if (access === undefined) return none();
    if (
      !plain(access) ||
      Object.keys(access).some((key) => !["devices", "create"].includes(key)) ||
      typeof access.create !== "boolean" ||
      !Array.isArray(access.devices) ||
      access.devices.length > MAX_DEVICES
    )
      throw invalid();
    const devices = access.devices.map((entry) => {
      if (
        !plain(entry) ||
        Object.keys(entry).some((key) => !["deviceId", "manage"].includes(key)) ||
        !isDeviceId(entry.deviceId) ||
        typeof entry.manage !== "boolean"
      )
        throw invalid();
      return { deviceId: entry.deviceId, manage: entry.manage };
    });
    if (new Set(devices.map((entry) => entry.deviceId)).size !== devices.length)
      throw invalid();
    return { devices, create: access.create };
  }
  /** What the own file of session `id` says of it now, or null once it is removed. */
  session(id) {
    if (!sessionId.test(String(id))) return null;
    try {
      const stored = readJSON(path.join(this.sessions, `${id}.json`), null);
      return stored?.id === id ? stored : null;
    } catch {
      return null;
    }
  }
  // The entry of session `id` while that very session exists.
  #entry(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const session = this.session(id);
    return session && session.createdAt === entry.createdAt ? { entry, session } : null;
  }
  /** Whether session `id` still exists (a device's creator). */
  exists(id) {
    return !!this.session(id);
  }
  /** `[{ deviceId, manage }]` of session `id`, for the device service. */
  grantsOf(id) {
    return this.#entry(id)?.entry.devices ?? [];
  }
  /** Whether session `id` may create devices. */
  canCreate(id) {
    return this.#entry(id)?.entry.create === true;
  }
  /** `[{ kind: "session", id, name, manage }]` for device `deviceId`'s view. */
  assignmentsOf(deviceId) {
    const found = [];
    for (const [id, entry] of this.entries) {
      const grant = entry.devices.find((item) => item.deviceId === deviceId);
      const live = grant && this.#entry(id);
      if (live)
        found.push({
          kind: "session",
          id,
          name: typeof live.session.name === "string" ? live.session.name : entry.name,
          manage: grant.manage,
        });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  /** `{ devices, create }` of this very session. */
  get(session) {
    const entry = this.entries.get(session?.id);
    return entry && entry.createdAt === session.createdAt
      ? { devices: entry.devices.map((item) => ({ ...item })), create: entry.create }
      : none();
  }
  /** Replaces the access of `session`; no device and no `create` removes its entry. */
  set(session, access) {
    const { devices, create } = this.validate(access);
    if (!sessionId.test(String(session?.id))) throw invalid();
    if (!devices.length && !create) {
      if (this.entries.has(session.id))
        this.#commit((entries) => entries.delete(session.id));
      return none();
    }
    this.#commit((entries) =>
      entries.set(session.id, {
        createdAt: session.createdAt,
        name: typeof session.name === "string" ? session.name.slice(0, 200) : "",
        devices,
        create,
      }),
    );
    return this.get(session);
  }
  /**
   * Session `id` was removed. Always announced: a device it created shows from now
   * on that its creator is gone. Never throws, because a session's removal and the
   * cleanup of a failed launch go on after it: without an entry nothing is written,
   * and an entry that cannot be removed from the file is logged and stays, where it
   * grants nothing (its session is gone).
   */
  discard(id) {
    if (this.entries.has(id))
      try {
        const next = new Map(this.entries);
        next.delete(id);
        this.#store(next);
      } catch (error) {
        console.error(
          `AgentPier could not remove a session's device access: ${error?.code || "unknown error"}`,
        );
      }
    this.#announce();
  }
  /** Device `deviceId` was removed: no session keeps a grant for it. */
  dropDevice(deviceId) {
    const next = new Map(this.entries);
    let changed = false;
    for (const [id, entry] of this.entries) {
      const devices = entry.devices.filter((item) => item.deviceId !== deviceId);
      if (devices.length === entry.devices.length) continue;
      changed = true;
      if (devices.length || entry.create) next.set(id, { ...entry, devices });
      else next.delete(id);
    }
    if (!changed) return;
    this.#store(next);
    this.#announce();
  }
}
