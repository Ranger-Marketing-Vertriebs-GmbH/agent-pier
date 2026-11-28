import fs from "node:fs";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { isDeviceId } from "./avd-files.js";
import { devicePaths } from "./device-paths.js";
import { refusal } from "./device-registry.js";
import { areaOf } from "./host-area.js";

/*
 * Which devices the owner assigned to which agent, and which agents may create
 * devices: `<data>/devices/agent-grants.json`,
 *
 *   { version: 1, agents: { "<agent id>": { create, devices: [{ deviceId, manage }],
 *     area: { path, dev, ino } | null } } }
 *
 * `manage` allows reset and delete; `create` allows creating devices and is off
 * unless the owner turns it on. A device an agent created is its own without any
 * entry here (device-access.js). What a lead passes on to a member for one task is
 * not stored here either (assistants/member-device-passes.js).
 *
 * `area` is the agent's workspace as one folder (host-area.js): its real path with
 * its device and inode numbers, recorded when the owner saves the agent's devices
 * and otherwise the first time a file travels between the workspace and a device.
 * From then on files travel only while the folder at that path is that very folder;
 * a workspace that was moved or replaced (a restored backup too) is refused until
 * the owner saves the agent's devices again.
 *
 * The device service asks this store without waiting, so the store asks for an
 * agent through `agent(id)`: the stored agent, `null` once it is deleted, and
 * `undefined` while the agents cannot be read at all. An entry counts only while its
 * agent exists and `eligible(agent)` holds (an owner's own agent: not archived, not
 * an agent of restricted users, no bot for other people); an agent that cannot be
 * read has no grant. A change is written to the file before it counts in memory, so
 * the two never differ.
 *
 * `onChange()` hears every change (the wiring signals the live topics).
 */
const MAX_DEVICES = 20;
const agentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => refusal("DEVICE_ASSIGNMENT_INVALID", 400);
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const none = () => ({ devices: [], create: false });
const areaShape = (area) =>
  plain(area) &&
  typeof area.path === "string" &&
  path.isAbsolute(area.path) &&
  typeof area.dev === "string" &&
  typeof area.ino === "string"
    ? { path: area.path, dev: area.dev, ino: area.ino }
    : null;

export class AgentDeviceGrants {
  constructor({ dataDir, agent, eligible = () => true }) {
    this.file = path.join(devicePaths(dataDir).root, "agent-grants.json");
    this.lookup = agent;
    this.eligibleAgent = eligible;
    this.onChange = null;
    this.entries = this.#read();
  }
  #read() {
    let stored = null;
    try {
      stored = readJSON(this.file, null);
    } catch {
      // A damaged file grants nothing; the next change writes a sound one.
    }
    const entries = new Map();
    if (!plain(stored?.agents)) return entries;
    for (const [id, entry] of Object.entries(stored.agents)) {
      if (!agentId.test(id) || !plain(entry)) continue;
      try {
        entries.set(id, {
          ...this.validate({ devices: entry.devices, create: entry.create }),
          area: areaShape(entry.area),
        });
      } catch {
        // An entry of another shape grants nothing.
      }
    }
    return entries;
  }
  // The file first, then what is known in memory: a change that cannot be stored
  // is no change.
  #store(entries) {
    if (entries.size) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writePrivate(this.file, { version: 1, agents: Object.fromEntries(entries) });
    } else fs.rmSync(this.file, { force: true });
    this.entries = entries;
  }
  #announce() {
    try {
      this.onChange?.();
    } catch {
      console.error("AgentPier could not announce an agent's device access.");
    }
  }
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
  /** The stored agent `id`, null once it is deleted, undefined when unreadable. */
  agent(id) {
    if (!agentId.test(String(id))) return null;
    try {
      return this.lookup(id);
    } catch {
      return undefined;
    }
  }
  /** Whether agent `id` still exists (a device's creator); unreadable counts as yes. */
  exists(id) {
    return this.agent(id) !== null;
  }
  /** Whether agent `id` exists and can be given devices now. */
  eligible(id) {
    const agent = this.agent(id);
    try {
      return !!agent && this.eligibleAgent(agent) === true;
    } catch {
      return false;
    }
  }
  // The entry of agent `id` while it counts.
  #entry(id) {
    const entry = this.entries.get(id);
    return entry && this.eligible(id) ? entry : null;
  }
  /** `[{ deviceId, manage }]` of agent `id`, for the device service. */
  grantsOf(id) {
    return this.#entry(id)?.devices ?? [];
  }
  /** Whether agent `id` may create devices. */
  canCreate(id) {
    return this.#entry(id)?.create === true;
  }
  /** `[{ kind: "agent", id, name, manage }]` for device `deviceId`'s view. */
  assignmentsOf(deviceId) {
    const found = [];
    for (const [id, entry] of this.entries) {
      const grant = entry.devices.find((item) => item.deviceId === deviceId);
      const agent = grant && this.agent(id);
      if (agent)
        found.push({
          kind: "agent",
          id,
          name: typeof agent.name === "string" ? agent.name : "",
          manage: grant.manage,
        });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  /** `{ devices, create }` as the owner set it for agent `id`. */
  get(id) {
    const entry = this.entries.get(id);
    return entry
      ? { devices: entry.devices.map((item) => ({ ...item })), create: entry.create }
      : none();
  }
  // The folder at `workspace` as an area, or null while there is none.
  #pin(workspace) {
    try {
      return typeof workspace === "string" && workspace ? areaOf(workspace) : null;
    } catch {
      return null;
    }
  }
  /**
   * Replaces the access of agent `id` and records its workspace as its area anew
   * (the owner's word that the folder there is the agent's). No device, no `create`
   * and no workspace removes its entry.
   */
  set(id, access, { workspace = null } = {}) {
    const { devices, create } = this.validate(access);
    if (!agentId.test(String(id))) throw invalid();
    const area = this.#pin(workspace) ?? this.entries.get(id)?.area ?? null;
    if (!devices.length && !create && !area) {
      if (this.entries.has(id)) this.#commit((entries) => entries.delete(id));
      return none();
    }
    this.#commit((entries) => entries.set(id, { devices, create, area }));
    return this.get(id);
  }
  /**
   * The area of agent `id`: the one recorded for it, or, when none was recorded yet,
   * the folder at `workspace` as it is now, recorded before it is returned. Null
   * without a workspace folder. Whether the folder is still the recorded one is
   * host-area.js's check at every use.
   */
  area(id, workspace) {
    if (!agentId.test(String(id))) return null;
    const known = this.entries.get(id)?.area;
    if (known) return { ...known };
    const area = this.#pin(workspace);
    if (!area) return null;
    const entry = this.entries.get(id) ?? none();
    // Not announced: nothing the owner sees changed.
    const next = new Map(this.entries);
    next.set(id, { devices: entry.devices, create: entry.create, area });
    this.#store(next);
    return { ...area };
  }
  /**
   * Agent `id` was deleted. Always announced: a device it created shows from now on
   * that its creator is gone. Never throws, because the deletion goes on after it:
   * an entry that cannot be removed from the file is logged and stays, where it
   * grants nothing (its agent is gone).
   */
  discard(id) {
    if (this.entries.has(id))
      try {
        const next = new Map(this.entries);
        next.delete(id);
        this.#store(next);
      } catch (error) {
        console.error(
          `AgentPier could not remove an agent's device access: ${error?.code || "unknown error"}`,
        );
      }
    this.#announce();
  }
  /** Device `deviceId` was removed: no agent keeps a grant for it. */
  dropDevice(deviceId) {
    const next = new Map(this.entries);
    let changed = false;
    for (const [id, entry] of this.entries) {
      const devices = entry.devices.filter((item) => item.deviceId !== deviceId);
      if (devices.length === entry.devices.length) continue;
      changed = true;
      if (devices.length || entry.create || entry.area)
        next.set(id, { ...entry, devices });
      else next.delete(id);
    }
    if (!changed) return;
    this.#store(next);
    this.#announce();
  }
}
