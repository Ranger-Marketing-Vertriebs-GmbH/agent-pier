import fs from "node:fs";
import path from "node:path";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
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
// A browser used this recently is still at work and is never stopped for another.
const busyMs = 60 * 1000;
const slotPattern = /^member(-visible)?-\d+$/;

/**
 * The agents' own browsers on the running Gateway (docs/assistant-gateway.md "Browser
 * isolation"). The team plugin's tool guard asks `policy` before every browser call:
 * the answer pins the call to the agent's own profile, or refuses it. It also keeps
 * the limits: at most `limit` visible browsers at once (the least recently used idle
 * one stops for a new one; with none idle the call is refused) and an idle stop
 * after `idleMs`. Temporary team members borrow a member slot whose data is
 * discarded when they end; a promoted member takes its slot's data along.
 */
export class AgentBrowsers {
  constructor({
    store,
    runtime,
    now = Date.now,
    limit = visibleBrowserLimit,
    idleMs = browserIdleMs,
    sweepMs = 60 * 1000,
    keeper = (cdpPort) => new BrowserWindowKeeper(cdpPort),
  }) {
    Object.assign(this, { store, runtime, now, limit, idleMs, sweepMs, keeper });
    // Profile name -> { lastUse, headless, keeper }; only browsers AgentPier started.
    this.running = new Map();
    // Temporary member id -> slot name.
    this.slots = new Map();
    this.onChange = () => {};
    runtime?.on?.("status", (state) => {
      if (state.availability !== "ready") this.forget();
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
      Object.keys(input).some((k) => !["agentId", "action"].includes(k))
    )
      throw assistantProblem("invalid");
    textValue(input.agentId, 4096);
    if ("action" in input && input.action !== undefined) textValue(input.action, 64);
    const deny = (reason) => ({ allow: false, reason });
    if (!this.ready()) return deny("unavailable");
    const assistant = this.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === input.agentId);
    if (!assistant || !personalCapabilities(assistant).browser) return deny("notGranted");
    // Copying cookies from a system browser profile is never an agent's call.
    if (input.action === "importprofile") return deny("importBlocked");
    const name = this.profileOf(assistant);
    if (!name) return deny(inheritsFromLead(assistant) ? "slotsBusy" : "restartNeeded");
    const entry = this.profiles()[name];
    if (!this.running.has(name) && !entry.headless) {
      const reason = await this.admitVisible();
      if (reason) return deny(reason);
    }
    if (input.action === "stop") {
      this.release(name);
      return { allow: true, profile: name };
    }
    this.used(name, entry);
    return { allow: true, profile: name };
  }
  /** The compiled profile `assistant` drives, assigning a member slot when needed. */
  profileOf(assistant, assign = true) {
    const profiles = this.profiles();
    if (!inheritsFromLead(assistant)) {
      const name = personalEligible(assistant) && agentProfileName(assistant.id);
      return name && profiles[name] ? name : null;
    }
    const held = this.slots.get(assistant.id);
    if (held && profiles[held]) return held;
    if (!assign) return null;
    let lead = null;
    try {
      lead = this.store.getAssistant(assistant.parentAssistantId);
    } catch {
      /* No lead: a headless slot. */
    }
    const visible =
      lead?.browserVisible === true && this.runtime.webTools?.visibleBrowser === true;
    const taken = new Set(this.slots.values());
    for (let index = 0; index < memberSlotCount; index++) {
      const name = memberSlotName(visible, index);
      if (profiles[name] && !taken.has(name)) {
        this.slots.set(assistant.id, name);
        return name;
      }
    }
    return null;
  }
  /** Room for one more visible browser, or the reason there is none. */
  async admitVisible() {
    const visible = [...this.running.entries()].filter(([, e]) => !e.headless);
    if (visible.length < this.limit) return null;
    const idle = visible
      .filter(([, e]) => this.now() - e.lastUse >= busyMs)
      .sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
    if (!idle) return "visibleLimit";
    await this.stop(idle[0]);
    return null;
  }
  used(name, entry) {
    const current = this.running.get(name);
    if (current) {
      current.lastUse = this.now();
      return;
    }
    const keeper = entry.headless ? null : this.keeper(entry.cdpPort);
    keeper?.start().catch(() => {});
    this.running.set(name, { lastUse: this.now(), headless: entry.headless, keeper });
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
    for (const [name, entry] of [...this.running])
      if (this.now() - entry.lastUse >= this.idleMs) await this.stop(name);
    for (const [memberId, slot] of [...this.slots]) {
      let member = null;
      try {
        member = this.store.getAssistant(memberId);
      } catch {
        /* Removed. */
      }
      if (member && inheritsFromLead(member)) continue;
      this.slots.delete(memberId);
      await this.stop(slot);
      const target =
        member && personalEligible(member) ? agentProfileName(member.id) : null;
      // A promoted member keeps its logins; any other end discards them.
      if (target && !fs.existsSync(this.profileDir(target)))
        moveProfile(this.profileDir(slot), this.profileDir(target));
      else removeProfile(this.profileDir(slot));
    }
    // Slot data no member holds any more, for example after AgentPier restarted.
    const taken = new Set(this.slots.values());
    for (const name of listProfiles(this.browserRoot()))
      if (slotPattern.test(name) && !taken.has(name) && !this.running.has(name)) {
        if (this.ready()) await this.stop(name);
        removeProfile(this.profileDir(name));
      }
  }
  /** What the agent's settings show. */
  status(id) {
    const assistant = this.store.getAssistant(id);
    const name = inheritsFromLead(assistant)
      ? this.slots.get(assistant.id) || null
      : personalEligible(assistant)
        ? agentProfileName(assistant.id)
        : null;
    const entry = name && this.profiles()[name];
    return {
      running: !!name && this.running.has(name),
      visible: !!entry && entry.headless === false,
      stored: !!name && fs.existsSync(this.profileDir(name)),
      resettable: !inheritsFromLead(assistant) && personalEligible(assistant),
    };
  }
  /** Whether the agent's browser runs now, for the agents list. */
  isRunning(id) {
    for (const [memberId, slot] of this.slots)
      if (memberId === id) return this.running.has(slot);
    const name = agentProfileName(id);
    return !!name && this.running.has(name);
  }
  /** Stops the agent's browser and deletes its profile: logins, cookies, history. */
  async reset(id) {
    const assistant = this.store.getAssistant(id);
    if (inheritsFromLead(assistant) || !personalEligible(assistant))
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
