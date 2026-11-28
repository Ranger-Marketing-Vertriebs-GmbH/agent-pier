import fs from "node:fs";
import path from "node:path";
import { writePrivate } from "../../lib/storage.js";
import { isDeviceId } from "./avd-files.js";
import { devicePaths } from "./device-paths.js";
import { refusal } from "./device-registry.js";
import { readGrants } from "./grant-file.js";
import { AREA_CHANGED, areaOf } from "./host-area.js";

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
 *
 * Only the workspace folder itself is ever recorded (`#workspaceArea`): a folder,
 * never a link, whose real path is exactly its name below the real path of the
 * workspaces folder the agent's runtime names (OpenClaw: `<workspaces>/<agent id>`;
 * Hermes: what its fleet's `workspaceOf` answers), and that is neither AgentPier's
 * data folder, a folder above it, nor in the devices' own folder. A link to the data
 * folder or to a folder elsewhere in the workspace's place is therefore no area, for
 * the owner's save and for a first transfer alike (WORKSPACE_MISPLACED).
 *
 * At every use the recorded folder must still be that workspace folder: the same
 * real path, the same device and inode numbers (`area`; host-area.js checks the
 * numbers once more on the folder it opens). A workspace that was moved or replaced
 * (a restored backup too), and a record of a folder elsewhere, are refused until the
 * owner saves the agent's devices again. That save is the owner's repair: it records
 * the folder anew when the recorded one is gone or is no longer the folder at the
 * workspace's place, and only a folder that passes the check above. While the
 * recorded folder is still the workspace, a save leaves the record as it is.
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
/** What an agent reads when a link or a folder elsewhere stands for its workspace. */
export const WORKSPACE_MISPLACED =
  "The workspace of this agent is not a folder of its own at its place below AgentPier's workspaces folder (a link stands there, or it lies elsewhere), so no file travels to or from a device. Tell the owner.";
const MAX_DEVICES = 20;
const agentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => refusal("DEVICE_ASSIGNMENT_INVALID", 400);
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const none = () => ({ devices: [], create: false });
const misplaced = () =>
  refusal("DEVICE_PATH_OUTSIDE", 403, { detail: WORKSPACE_MISPLACED });
const changed = () => refusal("DEVICE_PATH_OUTSIDE", 403, { detail: AREA_CHANGED });
// Whether `target` is `root` or lies below it.
const within = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
const sameArea = (a, b) =>
  !!a && !!b && a.path === b.path && a.dev === b.dev && a.ino === b.ino;
const areaShape = (area) =>
  plain(area) &&
  typeof area.path === "string" &&
  path.isAbsolute(area.path) &&
  typeof area.dev === "string" &&
  typeof area.ino === "string"
    ? { path: area.path, dev: area.dev, ino: area.ino }
    : null;

export class AgentDeviceGrants {
  /** `now()` and `log(line)` are for a damaged file (grant-file.js); tests replace them. */
  constructor({ dataDir, agent, eligible = () => true, now, log }) {
    this.dataDir = path.resolve(dataDir);
    this.root = devicePaths(dataDir).root;
    this.file = path.join(this.root, "agent-grants.json");
    this.lookup = agent;
    this.eligibleAgent = eligible;
    this.onChange = null;
    // A damaged file, and an entry of another shape, grant nothing; the file is
    // kept aside and logged, and the file is written anew from what counts.
    this.entries = readGrants(
      this.file,
      "agents",
      (id, entry) =>
        agentId.test(id) && plain(entry)
          ? {
              ...this.validate({ devices: entry.devices, create: entry.create }),
              area: areaShape(entry.area),
            }
          : null,
      { now, log, rewrite: (entries) => this.#store(entries) },
    );
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
  // Whether the real folder `real` is no place for a workspace: AgentPier's data
  // folder, a folder above it, or the devices' own folder and what lies below it.
  #reserved(real) {
    try {
      return (
        within(real, fs.realpathSync(this.dataDir)) ||
        (fs.existsSync(this.root) && within(fs.realpathSync(this.root), real))
      );
    } catch {
      return true;
    }
  }
  // The folder at `workspace` as an area when it is the workspace folder itself: a
  // folder and no link, at exactly its name below the real folder above it, and in
  // no reserved place. Null otherwise, and while there is no folder.
  #workspaceArea(workspace) {
    try {
      if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return null;
      if (!fs.lstatSync(workspace).isDirectory()) return null;
      const area = areaOf(workspace);
      const above = fs.realpathSync(path.dirname(workspace));
      if (area.path !== path.join(above, path.basename(workspace))) return null;
      return this.#reserved(area.path) ? null : area;
    } catch {
      return null;
    }
  }
  /**
   * Replaces the access of agent `id`. With `workspace` (the owner saved something
   * for the agent) its area is recorded anew when none is recorded or the recorded
   * folder is no longer the folder at the workspace's place, and only when the
   * folder there now is the workspace folder itself; otherwise the record stays as
   * it is. No device, no `create` and no recorded area removes its entry.
   */
  set(id, access, { workspace = null } = {}) {
    const { devices, create } = this.validate(access);
    if (!agentId.test(String(id))) throw invalid();
    const recorded = this.entries.get(id)?.area ?? null;
    const there = workspace ? this.#workspaceArea(workspace) : null;
    const area = there && !sameArea(there, recorded) ? there : recorded;
    if (!devices.length && !create && !area) {
      if (this.entries.has(id)) this.#commit((entries) => entries.delete(id));
      return none();
    }
    this.#commit((entries) => entries.set(id, { devices, create, area }));
    return this.get(id);
  }
  /**
   * The area of agent `id` for one use: the folder recorded for it while that is
   * still the workspace folder at `workspace`, or, when none was recorded yet, that
   * workspace folder, recorded before it is returned. Null without any folder at
   * `workspace`. Throws DEVICE_PATH_OUTSIDE (403) with a `detail`: AREA_CHANGED when
   * the recorded folder is gone, was replaced or is a folder elsewhere, and
   * WORKSPACE_MISPLACED when what stands at `workspace` is not the workspace folder
   * itself and nothing was recorded.
   */
  area(id, workspace) {
    if (!agentId.test(String(id))) return null;
    const known = this.entries.get(id)?.area;
    const area = this.#workspaceArea(workspace);
    if (known) {
      if (!sameArea(area, known)) throw changed();
      return { ...known };
    }
    if (!area) {
      // Nothing at the workspace's place is no folder yet; anything else there (a
      // link, also one that leads nowhere, a folder that fails the check) is refused.
      try {
        fs.lstatSync(workspace);
      } catch {
        return null;
      }
      throw misplaced();
    }
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
