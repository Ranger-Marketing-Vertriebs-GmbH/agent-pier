import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { TicketSourceError } from "./http-json.js";
import { ruleInput } from "./rule-input.js";
import { labelKey } from "./ticket.js";

const copy = serverMessages.tickets;
// JSON with sorted keys, so two spellings of the same options compare equal.
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/**
 * A label rule as the owner routes and the `tickets.rules` topic show it: its options in
 * full (the dialog edits them, they hold no secret), how many tickets it picked up and
 * its poll status as a code. `capped`: the last pass read only the first open tickets
 * of a large source, so labelled ones beyond them were not seen. Whether an error was
 * already pushed stays on the server.
 */
function publicRule(rule, picked) {
  return {
    id: rule.id,
    source: rule.source,
    label: rule.label,
    kind: rule.kind,
    options: rule.options,
    paused: rule.paused,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    picked,
    status: {
      checkedAt: rule.status.checkedAt,
      error: rule.status.error,
      capped: rule.status.capped === true,
    },
  };
}

/** The owner's label rules of a project: list, create, edit and delete. */
export class TicketRuleService {
  constructor({ rules, tickets, monitor }) {
    Object.assign(this, { rules, tickets, monitor });
  }

  public(projectId, rule) {
    return publicRule(rule, this.rules.pickupCount(projectId, rule.id));
  }

  view(projectId) {
    const project = this.tickets.resolveProject(projectId);
    const rules = this.rules.rules(project.id).map((r) => this.public(project.id, r));
    // The rule file is off and read-only (rule-store.js): its code, and the version a
    // newer AgentPier wrote, for the Label rules section.
    return this.rules.locked ? { rules, locked: this.rules.locked } : { rules };
  }

  /** A rule needs its source and GitHub, which its sequence opens pull requests on. */
  async connected(projectId, checked) {
    const project = this.tickets.resolveProject(projectId);
    const { link: _link, ...accesses } = await this.tickets.accesses(project);
    if (!accesses[checked.source]) throw new TicketSourceError("notConnected");
    if (!accesses.github) throw problem(copy.ruleGithubRequired, 409);
    return project;
  }

  async create(projectId, input) {
    this.rules.refuseLocked();
    const checked = ruleInput(input);
    const project = await this.connected(projectId, checked);
    const made = this.rules.create(project.id, checked);
    if (!made.paused) this.monitor?.request();
    return this.public(project.id, made);
  }

  /**
   * A full replace, `paused` included: Pause and Resume send the saved rule. A change of
   * `paused` alone needs no connected source, so a failing rule can still be paused.
   */
  async update(projectId, ruleId, input) {
    this.rules.refuseLocked();
    const checked = ruleInput(input);
    const saved = this.rules.rule(projectId, ruleId);
    const same = (rule) =>
      canonical([rule.source, labelKey(rule.label), rule.kind, rule.options]);
    if (saved && same(saved) === same(checked)) {
      const made = this.rules.update(projectId, ruleId, checked);
      if (!made.paused) this.monitor?.request();
      return this.public(projectId, made);
    }
    const project = await this.connected(projectId, checked);
    const made = this.rules.update(project.id, ruleId, checked);
    if (!made.paused) this.monitor?.request();
    return this.public(project.id, made);
  }

  /** Works for a project that is gone too, so its rules can still be removed. */
  remove(projectId, ruleId) {
    this.rules.remove(projectId, ruleId);
  }
}
