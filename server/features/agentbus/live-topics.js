// The live `agentbus.changed[:<projectId>]` signal topic, owner only like the
// AgentBus routes. It carries no data: the overview reads GET /api/agentbus and the
// message log its page of GET /api/agentbus/projects/:id/messages once per `changed`.
//
// A project's AgentBus state lives in its folder under <data>/agentbus/projects/<id>
// (agent-bus.js): the queue database (`queue.sqlite` and its write-ahead log) and
// the registered peers (`peers/`). The topic watches that folder, filtered to those
// names, and the peers folder, so a message, a claim, an acknowledgement and a peer
// registration (an atomic rename) send `changed`; the log also has a watch of its
// own, since macOS reports writes through a held-open file only there. The shared-memory index
// (`queue.sqlite-shm`) is left out: readers touch it, and a refetch must not feed
// itself. `agentbus.changed:<id>` watches one project; the bare topic watches every
// project of an AgentBus session and also changes when those sessions change (start,
// stop, rename: OperationsEvents lists them every 2.5 s).
//
// One handle per folder (by path and inode) is shared by every subscriber and closed
// with the last one; folders are capped at 256 (logged once when reached). A handle that fails, or whose folder was
// replaced, is closed, signals and is armed again. A project whose folders cannot all
// be watched (past the cap, or refused) is never treated as watched: it signals every
// 10 s, as the former poll read, and tries to watch again each time. A project folder
// not made yet is awaited by a watch of the projects folder, filtered to its id.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DirectoryWatchers } from "../../lib/directory-watchers.js";

export const AGENTBUS_PROJECT_PARAM = /[a-f0-9]{64}/;
export const AGENTBUS_FALLBACK_MS = 10000;
const PROJECT_ID = /^[a-f0-9]{64}$/;
const QUEUE_NAMES = ["queue.sqlite", "queue.sqlite-wal", "peers"];

const owner = (principal) => principal?.role === "owner";

// What the overview shows of a session: a change of it is a change of the topic.
const sessionSignature = (session) =>
  JSON.stringify([
    session.id,
    session.name,
    session.tool,
    session.status,
    session.accountId,
    session.agentbus?.version,
  ]);

/** Per project id, the signature of its AgentBus sessions. */
function signaturesOf(sessions) {
  const projects = new Map();
  for (const session of sessions || []) {
    const projectId = session?.agentbus?.enabled ? session.agentbus.projectId : null;
    if (!PROJECT_ID.test(projectId || "")) continue;
    if (!projects.has(projectId)) projects.set(projectId, []);
    projects.get(projectId).push(sessionSignature(session));
  }
  return new Map([...projects].map(([id, list]) => [id, list.sort().join("\n")]));
}

const identityOf = async (target, folder = true) => {
  const stat = await fsp.stat(target, { bigint: true });
  if (folder ? !stat.isDirectory() : !stat.isFile()) throw new Error("wrong kind");
  return `${stat.dev}:${stat.ino}`;
};

/**
 * The followers of AgentBus project folders. `root()` is the AgentBus folder,
 * `sessions()` lists the sessions, `onSessions(listener)` follows their listing.
 */
export class AgentBusWatches {
  constructor({
    root,
    sessions,
    onSessions,
    watch = fs.watch,
    maxDirectories = 256,
    fallbackMs = AGENTBUS_FALLBACK_MS,
    timers = { setTimeout, clearTimeout },
  }) {
    Object.assign(this, { root, sessions, onSessions, fallbackMs, timers });
    this.directories = new DirectoryWatchers({ watch, maxDirectories });
    this.followers = new Set();
    this.signatures = null;
    this.seeded = null;
    this.stopSessions = null;
  }

  /**
   * Calls `signal()` on every change of the project `projectId` (every project of an
   * AgentBus session when undefined) while followed. Returns the stop function.
   */
  follow(projectId, signal) {
    const follower = {
      projectId,
      signal,
      releases: new Map(),
      state: "arming",
      closed: false,
      arming: false,
      again: false,
      timer: null,
    };
    this.followers.add(follower);
    this.followSessions();
    this.arm(follower);
    return () => this.unfollow(follower);
  }

  followSessions() {
    if (this.stopSessions) return;
    this.stopSessions =
      this.onSessions((sessions) => this.listed(sessions)) || (() => {});
    this.seeded = Promise.resolve()
      .then(() => this.sessions())
      .then(
        (sessions) => (this.signatures ??= signaturesOf(sessions)),
        () => (this.signatures ??= new Map()),
      );
  }

  /** A listing of the sessions: signal the followers of each project that changed. */
  listed(sessions) {
    const next = signaturesOf(sessions);
    const previous = this.signatures;
    this.signatures = next;
    if (!previous) return;
    const changed = new Set();
    for (const id of new Set([...previous.keys(), ...next.keys()]))
      if (previous.get(id) !== next.get(id)) changed.add(id);
    if (!changed.size) return;
    for (const follower of [...this.followers]) {
      if (follower.projectId && !changed.has(follower.projectId)) continue;
      follower.signal();
      // The overview's set of projects may have changed with them.
      if (!follower.projectId) this.arm(follower);
    }
  }

  /**
   * The [folder, names, dev:ino] to watch for `follower`, and whether they cover all
   * its projects (false when a project folder is missing or cannot be read).
   */
  async wanted(follower) {
    await this.seeded;
    const ids = follower.projectId
      ? [follower.projectId]
      : [...(this.signatures?.keys() || [])];
    const triples = [];
    let complete = true;
    const missing = [];
    for (const id of ids) {
      const home = path.join(this.root(), "projects", id);
      const identity = await identityOf(home).catch(() => null);
      if (!identity) {
        missing.push(id);
        continue;
      }
      triples.push([home, QUEUE_NAMES, identity]);
      // macOS reports no write through a file held open (SQLite) to a folder watch,
      // only to a watch of the file itself: the log gets its own handle. A missing
      // log is seen being made in the project folder.
      const log = path.join(home, "queue.sqlite-wal");
      const logIdentity = await identityOf(log, false).catch(() => null);
      if (logIdentity) triples.push([log, null, logIdentity]);
      const peers = path.join(home, "peers");
      // A missing peers folder is seen being made, as `peers` in the project folder.
      const peersIdentity = await identityOf(peers).catch(() => null);
      if (peersIdentity) triples.push([peers, null, peersIdentity]);
    }
    // A project folder not made yet is seen being made in the projects folder; only
    // without that folder does the timer signal.
    if (missing.length) {
      const projects = path.join(this.root(), "projects");
      const identity = await identityOf(projects).catch(() => null);
      if (identity) triples.push([projects, missing.sort(), identity]);
      else complete = false;
    }
    return { triples, complete };
  }

  async arm(follower) {
    if (follower.closed) return;
    this.timers.clearTimeout(follower.timer);
    follower.timer = null;
    if (follower.arming) {
      follower.again = true;
      return;
    }
    follower.arming = true;
    let found = { triples: [], complete: false };
    try {
      found = await this.wanted(follower);
    } catch {
      // The AgentBus folder cannot be read: nothing is watched, the timer signals.
    }
    follower.arming = false;
    if (follower.closed) return;
    if (follower.again) {
      follower.again = false;
      return this.arm(follower);
    }
    const wanted = new Map(
      found.triples.map((triple) => [JSON.stringify(triple), triple]),
    );
    for (const [key, release] of follower.releases)
      if (!wanted.has(key) || !release.alive()) {
        release();
        follower.releases.delete(key);
      }
    let { complete } = found;
    for (const [key, [directory, names, identity]] of wanted) {
      if (follower.releases.has(key)) continue;
      const release = this.directories.add(
        directory,
        names,
        (filename, type) => this.changed(follower, filename, type),
        identity,
      );
      if (release) follower.releases.set(key, release);
      else {
        complete = false;
        this.reportCap();
      }
    }
    follower.state = complete ? "armed" : "unwatched";
    if (!complete) {
      // Without a live handle for every folder: signal as the former poll read, and
      // try to watch again.
      follower.timer = this.timers.setTimeout(() => {
        follower.timer = null;
        if (follower.closed) return;
        follower.signal();
        this.arm(follower);
      }, this.fallbackMs);
      follower.timer?.unref?.();
    }
  }

  changed(follower, filename, type) {
    if (follower.closed) return;
    follower.signal();
    // A failed handle (no name) or an entry made, removed or replaced (the log, the
    // peers folder, a project folder): watch anew. A write alone changes no handle.
    const dead = [...follower.releases.values()].some((release) => !release.alive());
    if (dead || filename === undefined || type === "rename") this.arm(follower);
  }

  /** Logs once that the watch cap is reached: further folders signal every 10 s. */
  reportCap() {
    if (this.capReported || this.directories.size < this.directories.maxDirectories)
      return;
    this.capReported = true;
    console.warn(
      `AgentPier watches the most AgentBus folders it may (${this.directories.maxDirectories}); further projects are read every 10 s.`,
    );
  }

  unfollow(follower) {
    if (follower.closed) return;
    follower.closed = true;
    this.timers.clearTimeout(follower.timer);
    for (const release of follower.releases.values()) release();
    follower.releases.clear();
    this.followers.delete(follower);
    if (!this.followers.size) {
      this.stopSessions?.();
      this.stopSessions = null;
      this.signatures = null;
    }
  }

  close() {
    for (const follower of [...this.followers]) this.unfollow(follower);
    this.directories.close();
  }
}

/**
 * Defines `agentbus.changed` on `hub`; its watches live in `services.agentbusWatches`
 * and close with the hub.
 */
export function defineAgentBusTopic(hub, services) {
  const watches = new AgentBusWatches({
    root: () => services.agentbus.root,
    sessions: () => services.agentbus.sessions.list(),
    onSessions: (listener) => services.operationsEvents?.onSessions(listener),
  });
  services.agentbusWatches = watches;
  hub.define({
    name: "agentbus.changed",
    mode: "signal",
    param: AGENTBUS_PROJECT_PARAM,
    paramOptional: true,
    authorize: owner,
    scopeKey: () => "owner",
    watch: ({ param, invalidate }) => watches.follow(param, invalidate),
  });
  hub.onClose(() => watches.close());
}
