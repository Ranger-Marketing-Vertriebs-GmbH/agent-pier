import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { writePrivate, readJSON, problem } from "../../lib/storage.js";
import { TICKET_SOURCE_IDS, labelKey } from "./ticket.js";
import { ruleLabel } from "./rule-input.js";

const copy = serverMessages.tickets;
export const MAX_RULES = 20;
export const MAX_PICKUPS = 5000;
const VERSION = 1;
const MAX_OPTION_BYTES = 8192;

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const idText = (value, max = 200) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const stamp = (value) => (Number.isFinite(value) ? value : null);

function status(value) {
  const out = { checkedAt: null, error: null, notified: null };
  if (!plain(value)) return out;
  out.checkedAt = stamp(value.checkedAt);
  if (plain(value.error) && idText(value.error.code, 64))
    out.error = { code: value.error.code, since: stamp(value.error.since) ?? 0 };
  // The codes already pushed in the current failure episode; a string is the older
  // spelling of one code.
  const codes =
    (typeof value.notified === "string" ? [value.notified] : value.notified) ?? [];
  if (Array.isArray(codes)) {
    const kept = [...new Set(codes.filter((code) => idText(code, 64)))].slice(0, 16);
    if (kept.length) out.notified = kept;
  }
  // The last successful pass read only the first pages of the source (rule-monitor.js).
  if (value.capped === true) out.capped = true;
  return out;
}
function options(value) {
  if (!plain(value) || typeof value.allowMerge !== "boolean") return null;
  const out = { allowMerge: value.allowMerge };
  for (const name of ["session", "pipeline", "repair"]) {
    if (value[name] === undefined) continue;
    if (!plain(value[name]) || JSON.stringify(value[name]).length > MAX_OPTION_BYTES)
      return null;
    out[name] = value[name];
  }
  return out;
}
/** One saved rule, or null when it is not a valid rule. */
function rule(value) {
  if (!plain(value) || !idText(value.id, 100) || !idText(value.projectId)) return null;
  if (!TICKET_SOURCE_IDS.includes(value.source)) return null;
  // Labels are checked as ruleInput() checks them, so a hand-edited file matches too.
  const label = ruleLabel(value.label);
  if (!label || !["session", "pipeline"].includes(value.kind)) return null;
  const checkedOptions = options(value.options);
  if (!checkedOptions || typeof value.paused !== "boolean") return null;
  const createdAt = stamp(value.createdAt) ?? 0;
  return {
    id: value.id,
    projectId: value.projectId,
    source: value.source,
    label,
    kind: value.kind,
    options: checkedOptions,
    paused: value.paused,
    createdAt,
    updatedAt: stamp(value.updatedAt) ?? createdAt,
    status: status(value.status),
  };
}
function pickup(value) {
  if (!plain(value) || !idText(value.projectId) || !idText(value.key, 300)) return null;
  if (!TICKET_SOURCE_IDS.includes(value.source)) return null;
  if (!idText(value.ruleId) || !idText(value.itemId) || !Number.isFinite(value.at))
    return null;
  return {
    projectId: value.projectId,
    source: value.source,
    key: value.key,
    ruleId: value.ruleId,
    itemId: value.itemId,
    at: value.at,
  };
}
const pickupId = (projectId, source, key) => JSON.stringify([projectId, source, key]);

/**
 * The label rules of every repo, their poll status and the tickets they picked up, in
 * ticket-rules.json. Pickups outlive their rule and their queue item: they are what keeps
 * a ticket that still carries the label from being queued twice.
 */
export class TicketRuleStore {
  constructor({ dataDir, now = Date.now, log = () => {}, onChange = () => {} }) {
    this.now = now;
    this.log = log;
    this.onChange = onChange;
    this.file = path.join(dataDir, "ticket-rules.json");
    this.list = [];
    this.picks = new Map();
    // Set when the file cannot be used as it is: the rules are off and read-only, and the
    // file stays untouched, since dropping its pickups would queue tickets again.
    this.locked = null;
    let saved;
    let damaged = false;
    try {
      saved = readJSON(this.file, {});
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        this.lock({ code: "unreadable" }, `unreadable code=${error.code || "error"}`);
        return;
      }
      damaged = true;
    }
    if (
      !plain(saved) ||
      (saved.rules !== undefined && !Array.isArray(saved.rules)) ||
      (saved.pickups !== undefined && !Array.isArray(saved.pickups))
    )
      damaged = true;
    // A file a newer AgentPier wrote (a downgrade, a restored newer backup).
    if (!damaged && saved.version !== undefined && saved.version !== VERSION) {
      const version = Number.isSafeInteger(saved.version) ? saved.version : null;
      this.lock(
        { code: "unsupportedVersion", version },
        `unsupported version=${version ?? "invalid"}`,
      );
      return;
    }
    if (damaged) {
      fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
      saved = {};
    }
    let dropped = 0;
    for (const entry of saved.rules ?? []) {
      const checked = rule(entry);
      const clash = (other) =>
        other.id === checked?.id ||
        (other.projectId === checked?.projectId &&
          other.source === checked?.source &&
          labelKey(other.label) === labelKey(checked?.label));
      if (
        !checked ||
        this.list.some(clash) ||
        this.list.filter((other) => other.projectId === checked.projectId).length >=
          MAX_RULES
      )
        dropped += 1;
      else this.list.push(checked);
    }
    for (const entry of saved.pickups ?? []) {
      const checked = pickup(entry);
      const id = checked && pickupId(checked.projectId, checked.source, checked.key);
      if (!checked || this.picks.has(id)) dropped += 1;
      else this.picks.set(id, checked);
    }
    for (const projectId of new Set([...this.picks.values()].map((p) => p.projectId)))
      this.cap(projectId);
    if (dropped) this.log(`ticket-rules: dropped-invalid count=${dropped}`);
  }
  lock(locked, detail) {
    this.locked = locked;
    this.log(`ticket-rules: ${detail}, rules disabled`);
  }
  refuseLocked() {
    if (this.locked)
      throw Object.assign(problem(copy.rulesLocked, 409), {
        code: "TICKET_RULES_LOCKED",
      });
  }
  save() {
    this.refuseLocked();
    writePrivate(this.file, {
      version: VERSION,
      rules: this.list,
      pickups: [...this.picks.values()],
    });
  }
  changed(projectId) {
    try {
      this.onChange(projectId);
    } catch {}
  }
  /** Runs a change, saves it and puts memory back when the save fails. */
  commit(projectId, change) {
    const list = this.list;
    const picks = this.picks;
    this.list = [...list];
    this.picks = new Map(picks);
    try {
      const result = change();
      this.save();
      this.changed(projectId);
      return result;
    } catch (error) {
      this.list = list;
      this.picks = picks;
      throw error;
    }
  }
  cap(projectId) {
    const mine = [...this.picks.entries()].filter(([, p]) => p.projectId === projectId);
    const extra = mine.length - MAX_PICKUPS;
    if (extra <= 0) return;
    mine
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, extra)
      .forEach(([id]) => this.picks.delete(id));
  }
  rules(projectId) {
    return structuredClone(
      this.list
        .filter((entry) => entry.projectId === projectId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }
  rule(projectId, ruleId) {
    const found = this.list.find((e) => e.projectId === projectId && e.id === ruleId);
    return found ? structuredClone(found) : null;
  }
  allRules() {
    return structuredClone(this.list);
  }
  exists(projectId, checked, exceptId) {
    return this.list.some(
      (e) =>
        e.projectId === projectId &&
        e.id !== exceptId &&
        e.source === checked.source &&
        labelKey(e.label) === labelKey(checked.label),
    );
  }
  /** `checked` is the result of ruleInput(). */
  create(projectId, checked) {
    this.refuseLocked();
    if (!idText(projectId)) throw problem(copy.invalidRule);
    if (this.list.filter((e) => e.projectId === projectId).length >= MAX_RULES)
      throw problem(copy.tooManyRules, 409);
    if (this.exists(projectId, checked)) throw problem(copy.ruleExists, 409);
    const at = this.now();
    const made = rule({
      ...checked,
      id: randomUUID(),
      projectId,
      createdAt: at,
      updatedAt: at,
    });
    if (!made) throw problem(copy.invalidRule);
    this.commit(projectId, () => this.list.push(made));
    return structuredClone(made);
  }
  update(projectId, ruleId, checked) {
    this.refuseLocked();
    const index = this.list.findIndex(
      (e) => e.projectId === projectId && e.id === ruleId,
    );
    if (index < 0) throw problem(copy.ruleNotFound, 404);
    const current = this.list[index];
    if (this.exists(projectId, checked, ruleId)) throw problem(copy.ruleExists, 409);
    const moved =
      current.source !== checked.source ||
      labelKey(current.label) !== labelKey(checked.label);
    const made = rule({
      ...checked,
      id: current.id,
      projectId,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      status: moved ? { ...current.status, error: null, notified: null } : current.status,
    });
    if (!made) throw problem(copy.invalidRule);
    this.commit(projectId, () => (this.list[index] = made));
    return structuredClone(made);
  }
  /** Pickups stay, so a recreated rule never restarts a ticket. */
  remove(projectId, ruleId) {
    this.refuseLocked();
    if (!this.list.some((e) => e.projectId === projectId && e.id === ruleId))
      throw problem(copy.ruleNotFound, 404);
    this.commit(
      projectId,
      () =>
        (this.list = this.list.filter(
          (e) => !(e.projectId === projectId && e.id === ruleId),
        )),
    );
  }
  /** Whether a rule or a pickup still names the project; never while locked. */
  ownsProject(projectId) {
    return (
      !this.locked &&
      (this.list.some((e) => e.projectId === projectId) ||
        [...this.picks.values()].some((p) => p.projectId === projectId))
    );
  }
  /**
   * Moves a project's rules and pickups to the project it became. A rule whose source
   * and label the new project already has, or beyond its rule limit, is dropped; its
   * pickups move all the same, so no ticket is queued twice. A locked file stays.
   */
  moveProject(fromId, toId) {
    if (fromId === toId || !this.ownsProject(fromId)) return;
    this.commit(toId, () => {
      let count = this.list.filter((e) => e.projectId === toId).length;
      let overLimit = 0;
      const moved = [];
      for (const entry of this.list) {
        if (entry.projectId !== fromId) moved.push(entry);
        else if (this.exists(toId, entry)) continue;
        else if (count >= MAX_RULES) overLimit += 1;
        else {
          moved.push({ ...entry, projectId: toId });
          count += 1;
        }
      }
      if (overLimit) this.log(`ticket-rules: move dropped-over-limit count=${overLimit}`);
      this.list = moved;
      for (const [id, p] of [...this.picks]) {
        if (p.projectId !== fromId) continue;
        this.picks.delete(id);
        const next = pickupId(toId, p.source, p.key);
        if (!this.picks.has(next)) this.picks.set(next, { ...p, projectId: toId });
      }
      this.cap(toId);
    });
    this.changed(fromId);
  }
  setStatus(projectId, ruleId, next) {
    const index = this.list.findIndex(
      (e) => e.projectId === projectId && e.id === ruleId,
    );
    if (index < 0 || this.locked) return;
    this.commit(projectId, () => {
      this.list[index] = { ...this.list[index], status: status(next) };
    });
  }
  picked(projectId, source, key) {
    const found = this.picks.get(pickupId(projectId, source, key));
    return found ? { ...found } : null;
  }
  addPickups(projectId, entries) {
    this.refuseLocked();
    const added = [];
    for (const entry of entries) {
      const checked = pickup({ ...entry, projectId });
      if (!checked) throw problem(copy.invalidRule);
      added.push(checked);
    }
    if (!added.length) return;
    this.commit(projectId, () => {
      for (const checked of added) {
        const id = pickupId(projectId, checked.source, checked.key);
        if (!this.picks.has(id)) this.picks.set(id, checked);
      }
      this.cap(projectId);
    });
  }
  pickupCount(projectId, ruleId) {
    let count = 0;
    for (const p of this.picks.values())
      if (p.projectId === projectId && p.ruleId === ruleId) count += 1;
    return count;
  }
}
