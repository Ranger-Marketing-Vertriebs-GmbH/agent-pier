import fs from "node:fs";
import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
  browserVisible,
  inheritsFromLead,
  personalCapabilities,
  personalEligible,
} from "./native-capabilities.js";
import {
  agentProfileName,
  memberSlotCount,
  memberSlotName,
} from "./openclaw-config/browser-profiles.js";
import { BrowserWindowKeeper } from "./browser-window-keeper.js";

export const visibleBrowserLimit = 3;
export const browserIdleMs = 15 * 60 * 1000;
// The longest an idle browser stays for a window the owner keeps open.
export const browserIdleCapMs = 60 * 60 * 1000;
// A browser used this recently, or whose agent is at work, or a window the owner has
// open, is never stopped to make room for another.
export const browserBusyMs = 5 * 60 * 1000;
// OpenClaw's own budget for a browser start is 15 s.
const startTimeoutMs = 30000;
const slotPattern = /^member(-visible)?-\d+$/;
// Actions that read OpenClaw's state and never launch a browser (OpenClaw 2026.10.3).
const nonLaunching = new Set(["status", "profiles", "stop", "doctor"]);
// Gateway states after which its browsers are gone; a reconnect keeps them.
const gone = new Set(["stopping", "starting", "installing", "failed", "disabled"]);
// What only a permanent agent (also an archived one) owns: a profile of its own.
const ownsProfile = (assistant) =>
  !assistant.teamMemberId || assistant.lifetime === "permanent";

/**
 * The agents' own browsers on the running Gateway (docs/assistant-gateway.md "Browser
 * isolation"). The team plugin's tool guard asks `policy` before every browser call:
 * the answer pins the call to the agent's own profile, or refuses it. It also keeps
 * the limits: at most `limit` visible browsers at once (the least recently used one
 * that is not busy stops for a new one; with all busy the call is refused) and an
 * idle stop after `idleMs`. Temporary team members borrow a member slot whose data
 * is discarded when they end; a promoted member takes its slot's data along.
 * `busy(assistantId)` says whether the agent has a run in progress.
 */
export class AgentBrowsers {
  constructor({
    store,
    runtime,
    now = Date.now,
    limit = visibleBrowserLimit,
    idleMs = browserIdleMs,
    idleCapMs = browserIdleCapMs,
    busyMs = browserBusyMs,
    sweepMs = 60 * 1000,
    busy = () => false,
    keeper = (cdpPort, options) => new BrowserWindowKeeper(cdpPort, options),
  }) {
    Object.assign(this, {
      store,
      runtime,
      now,
      limit,
      idleMs,
      idleCapMs,
      busyMs,
      sweepMs,
      busy,
      keeper,
    });
    // Profile name -> { lastUse, headless, assistantId, keeper }: browsers a
    // launching call started, until they stop.
    this.running = new Map();
    // Temporary member id -> slot name; `releasing` slots are being discarded.
    this.slots = new Map();
    this.releasing = new Set();
    this.onChange = () => {};
    this.generation = runtime?.generation;
    runtime?.on?.("status", (state) => {
      if (gone.has(state.availability) || this.runtime.generation !== this.generation)
        this.forget();
      this.generation = this.runtime.generation;
    });
  }
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.sweep().catch(() => {}), this.sweepMs);
    this.timer.unref?.();
  }
  close() {
    clearInterval(this.timer);
    this.forget();
  }
  /** The Gateway went away: its browsers went with it. */
  forget() {
    const had = this.running.size > 0;
    for (const entry of this.running.values()) entry.keeper?.close();
    this.running.clear();
    if (had) this.onChange();
  }
  profiles() {
    return this.runtime?.webTools?.browserProfiles || {};
  }
  browserRoot() {
    return path.join(this.runtime.paths.state, "browser");
  }
  /** The profile directory OpenClaw keeps for `name`. */
  profileDir(name) {
    return path.join(this.browserRoot(), name);
  }
  ready() {
    return !!this.runtime?.client?.ready;
  }
  /** The bridge's answer for a browser call: `{ allow, profile }` or `{ allow, reason }`. */
  async policy(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((k) => !["agentId", "action", "sessionKey"].includes(k))
    )
      throw assistantProblem("invalid");
    if ("sessionKey" in input) textValue(input.sessionKey, 4096);
    textValue(input.agentId, 4096);
    if ("action" in input && input.action !== undefined) textValue(input.action, 64);
    // OpenClaw matches actions as given; any spelling of a refused one stays refused.
    const action = String(input.action ?? "")
      .trim()
      .toLowerCase();
    const deny = (reason) => ({ allow: false, reason });
    if (!this.ready()) return deny("unavailable");
    const assistant = this.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === input.agentId);
    if (!assistant || !personalCapabilities(assistant).browser) return deny("notGranted");
    // Copying cookies from a system browser profile is never an agent's call.
    if (action === "importprofile") return deny("importBlocked");
    // Someone holds the browser (browser-takeover.js): the agent waits for it. On a
    // user's own agent that is always her; on a shared one a driving user's views are
    // the only ones left; otherwise it is the owner.
    if (this.controlled?.(assistant.id)) {
      this.ownerControlRefused?.(assistant.id);
      if (assistant.userAccess?.mode === "own") return deny("userControl");
      if (assistant.userAccess && this.driver?.(assistant.id))
        return deny("sharedUserControl");
      return deny("ownerControl");
    }
    const name = this.profileOf(assistant);
    if (!name) return deny(inheritsFromLead(assistant) ? "slotsBusy" : "restartNeeded");
    const entry = this.profiles()[name];
    const current = this.running.get(name);
    if (action === "stop") {
      this.release(name);
      return { allow: true, profile: name };
    }
    if (current) current.lastUse = this.now();
    else if (!nonLaunching.has(action)) {
      const reason = await this.admit(name, entry, assistant.id);
      if (reason) return deny(reason);
    }
    return { allow: true, profile: name };
  }
  /** Room and tracking for a browser about to launch; a refusal's reason or null. */
  async admit(name, entry, assistantId) {
    const current = this.running.get(name);
    if (current) {
      current.lastUse = this.now();
      return null;
    }
    const reserve = () => this.launched(name, entry, assistantId);
    if (entry.headless) {
      reserve();
      return null;
    }
    const victim = await this.roomForVisible(reserve, name);
    if (victim === false) return "visibleLimit";
    if (victim) await this.stop(victim);
    return null;
  }
  /**
   * The profile the owner watches for agent `id` (browser-live-view.js), without
   * assigning a member slot: `{ name, entry }` or null.
   */
  viewProfile(id) {
    const assistant = this.store.getAssistant(id);
    if (!personalCapabilities(assistant).browser) return null;
    const name = inheritsFromLead(assistant)
      ? this.slots.get(assistant.id)
      : personalEligible(assistant) && agentProfileName(assistant.id);
    const entry = name && this.profiles()[name];
    return entry ? { name, entry } : null;
  }
  /** Why the owner cannot watch agent `id`: a member without a slot yet, or none. */
  viewReason(id) {
    const assistant = this.store.getAssistant(id);
    return inheritsFromLead(assistant) && personalCapabilities(assistant).browser
      ? "noSlot"
      : "noProfile";
  }
  /**
   * A running browser someone watches stays tracked, so a visible one keeps its
   * window keeper (focus emulation, the owner's windows); an untracked one (after an
   * AgentPier restart) is tracked again within the visible limit. Only a `full`
   * viewer, watching since `since`, keeps it from the idle stop, and at most
   * `idleCapMs` long: a chat's preview never does.
   */
  watched(id, { full = false, since = this.now() } = {}) {
    const view = this.viewProfile(id);
    if (!view) return;
    const current = this.running.get(view.name);
    if (current) {
      if (full && this.now() - since < this.idleCapMs) current.lastUse = this.now();
      return;
    }
    const visible = [...this.running.values()].filter((e) => !e.headless).length;
    if (view.entry.headless || visible < this.limit)
      this.launched(view.name, view.entry, id);
  }
  /** The owner starts the agent's browser from its live view, within the limits. */
  async ownerStart(id) {
    if (!this.ready()) throw assistantProblem("unavailable", 409);
    const assistant = this.store.getAssistant(id);
    if (!personalCapabilities(assistant).browser) throw assistantProblem("invalid");
    const name = this.profileOf(assistant);
    if (!name) throw assistantProblem("browserUnavailable", 409);
    const reason = await this.admit(name, this.profiles()[name], id);
    if (reason) throw assistantProblem("browserVisibleLimit", 409);
    // A cold launch takes about ten seconds, beyond the client's default budget.
    await this.runtime.client.request(
      "browser.request",
      { method: "POST", path: "/start", query: { profile: name } },
      { timeoutMs: startTimeoutMs },
    );
    return { profile: name };
  }
  /**
   * The owner stops the agent's browser from its live view (the profile it shows):
   * its open tabs close, its profile stays, and the agent's next call starts it again.
   */
  async ownerStop(id) {
    if (!this.ready()) throw assistantProblem("unavailable", 409);
    const view = this.viewProfile(id);
    if (!view) throw assistantProblem("invalid");
    // Unlike the idle stop, a failure reaches the owner and the browser stays tracked.
    await this.runtime.client.request("browser.request", {
      method: "POST",
      path: "/stop",
      query: { profile: view.name },
    });
    this.release(view.name);
  }
  /** The compiled profile `assistant` drives, assigning a member slot when needed. */
  profileOf(assistant) {
    const profiles = this.profiles();
    if (!inheritsFromLead(assistant)) {
      const name = personalEligible(assistant) && agentProfileName(assistant.id);
      return name && profiles[name] ? name : null;
    }
    const held = this.slots.get(assistant.id);
    if (held && profiles[held]) return held;
    let lead = null;
    try {
      lead = this.store.getAssistant(assistant.parentAssistantId);
    } catch {
      /* No lead: a headless slot. */
    }
    const visible =
      browserVisible(lead) && this.runtime.webTools?.visibleBrowser === true;
    const taken = new Set([...this.slots.values(), ...this.releasing]);
    for (let index = 0; index < memberSlotCount; index++) {
      const name = memberSlotName(visible, index);
      if (profiles[name] && !taken.has(name)) {
        this.slots.set(assistant.id, name);
        return name;
      }
    }
    return null;
  }
  /**
   * Makes room for one more visible browser and calls `reserve` in the same
   * synchronous step as the final count, so two calls never pass the limit together.
   * Returns null, the name of the browser to stop for it (already released), or
   * false when every visible browser is busy and nothing was reserved.
   */
  async roomForVisible(reserve, name) {
    const visible = [...this.running.entries()].filter(([, e]) => !e.headless);
    if (visible.length < this.limit) {
      reserve();
      return null;
    }
    const idle = [];
    for (const [name, e] of visible.sort((a, b) => a[1].lastUse - b[1].lastUse)) {
      const unused = this.now() - e.lastUse;
      if (unused < this.busyMs || this.busy(e.assistantId)) continue;
      // An open window holds its browser at most `idleCapMs` long, as in the sweep.
      if (unused < this.idleCapMs && (await e.keeper?.inUse?.().catch(() => false)))
        continue;
      idle.push(name);
    }
    // Recounted after the awaits: another call may have taken or freed a place, or
    // launched this very profile already.
    if (this.running.has(name)) {
      reserve();
      return null;
    }
    const now = [...this.running.values()].filter((e) => !e.headless).length;
    if (now < this.limit) {
      reserve();
      return null;
    }
    const victim = idle.find((name) => this.running.has(name));
    if (!victim) return false;
    this.release(victim);
    reserve();
    return victim;
  }
  /** A launching call: the browser runs from now on, watched until it ends. */
  launched(name, entry, assistantId) {
    const current = this.running.get(name);
    if (current) {
      current.lastUse = this.now();
      return;
    }
    const record = { lastUse: this.now(), headless: entry.headless, assistantId };
    record.keeper = this.keeper(entry.cdpPort, {
      windows: !entry.headless,
      // A browser that ended (stopped elsewhere, crashed, never came up) is gone.
      onClose: () => {
        if (this.running.get(name) === record) this.release(name);
      },
    });
    this.running.set(name, record);
    record.keeper.start().catch(() => {});
    this.onChange();
  }
  release(name) {
    const entry = this.running.get(name);
    if (!entry) return;
    entry.keeper?.close();
    this.running.delete(name);
    this.onChange();
  }
  /** Stops the Gateway's browser for `name`; a failure leaves nothing running here. */
  async stop(name) {
    this.release(name);
    if (!this.ready()) return;
    await this.runtime.client
      .request("browser.request", {
        method: "POST",
        path: "/stop",
        query: { profile: name },
      })
      .catch(() => {});
  }
  /** Idle stops, and the slots of members that ended. */
  async sweep() {
    for (const [name, entry] of [...this.running]) {
      const idle = this.now() - entry.lastUse;
      if (idle < this.idleMs) continue;
      // A window the owner has open keeps its browser, at most `idleCapMs` long.
      if (idle < this.idleCapMs && (await entry.keeper?.inUse?.().catch(() => false)))
        continue;
      if (this.running.get(name) === entry) await this.stop(name);
    }
    for (const [memberId, slot] of [...this.slots]) {
      let member = null;
      try {
        member = this.store.getAssistant(memberId);
      } catch {
        /* Removed. */
      }
      if (member && inheritsFromLead(member)) continue;
      // Held until its data is gone, so no other member gets it meanwhile.
      this.releasing.add(slot);
      this.slots.delete(memberId);
      try {
        await this.stop(slot);
        const target =
          member && personalEligible(member) ? agentProfileName(member.id) : null;
        // A promoted member keeps its logins; any other end discards them.
        if (target && !fs.existsSync(this.profileDir(target)))
          moveProfile(this.profileDir(slot), this.profileDir(target));
        else removeProfile(this.profileDir(slot));
      } finally {
        this.releasing.delete(slot);
      }
    }
    // Slot data no member holds any more, for example after AgentPier restarted.
    const unheld = (name) =>
      slotPattern.test(name) &&
      ![...this.slots.values()].includes(name) &&
      !this.releasing.has(name) &&
      !this.running.has(name);
    for (const name of listProfiles(this.browserRoot()))
      if (unheld(name)) {
        this.releasing.add(name);
        try {
          if (this.ready()) await this.stop(name);
          // Checked again: a member may have taken the slot during the stop.
          this.releasing.delete(name);
          if (unheld(name)) removeProfile(this.profileDir(name));
        } finally {
          this.releasing.delete(name);
        }
      }
  }
  /** What the agent's settings show. */
  status(id) {
    const assistant = this.store.getAssistant(id);
    const name = inheritsFromLead(assistant)
      ? this.slots.get(assistant.id) || null
      : ownsProfile(assistant)
        ? agentProfileName(assistant.id)
        : null;
    const entry = name && this.profiles()[name];
    return {
      running: !!name && this.running.has(name),
      visible: !!entry && entry.headless === false,
      stored: !!name && fs.existsSync(this.profileDir(name)),
      resettable: !inheritsFromLead(assistant) && ownsProfile(assistant),
    };
  }
  /** Whether the agent's browser runs now, for the agents list. */
  isRunning(id) {
    const slot = this.slots.get(id);
    if (slot) return this.running.has(slot);
    const name = agentProfileName(id);
    return !!name && this.running.has(name);
  }
  /** Stops the agent's own browser, if it runs: its open tabs close, its profile stays. */
  async stopAgent(id) {
    const name = agentProfileName(id);
    if (name && this.running.has(name)) await this.stop(name);
  }
  /**
   * Stops the agent's browser and deletes its profile: logins, cookies, history.
   * An archived agent keeps its profile (archiving can be undone) and may reset it.
   */
  async reset(id) {
    const assistant = this.store.getAssistant(id);
    if (inheritsFromLead(assistant) || !ownsProfile(assistant))
      throw assistantProblem("invalid");
    const name = agentProfileName(assistant.id);
    if (!name) throw assistantProblem("invalid");
    await this.stop(name);
    removeProfile(this.profileDir(name));
    return this.status(id);
  }
}

function listProfiles(root) {
  try {
    return fs.readdirSync(root);
  } catch {
    return [];
  }
}
function removeProfile(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}
function moveProfile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "ENOENT") removeProfile(from);
  }
}
