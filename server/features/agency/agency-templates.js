// Agency agents as templates for AgentPier agents and team members: the catalog
// and pinned-revision preview of agency-store.js, without any CLI profile. Catalog
// text is untrusted: it is only parsed (name, description, body), never run, and
// scanned like an imported skill (skill-scan.js) before anyone may use it.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { scanSkill } from "../extensions/skill-scan.js";
import { repository } from "./source.js";
import { searchCatalog } from "./agency-store.js";

// Composed instructions stay well below an agent's 65,536 characters, so a team
// member's role and assignment (up to 8,392 more) still fit.
export const templateLimits = { instructions: 48000, query: 200 };
const idPattern = /^[a-z0-9][a-z0-9_-]{1,220}$/;
const revisionPattern = /^[a-f0-9]{40}$/;

export const templateProblem = (key, status) =>
  Object.assign(problem(serverMessages.agency[key], status), { key });

/** The instructions an agent starts with: description, body and attribution. */
export function templateInstructions(agent) {
  return `${agent.description}\n\n${agent.body}\n\n---\nTemplate: ${agent.name} (Agency agents)\nSource: ${agent.source}\nLicense: MIT, https://github.com/${repository}/blob/${agent.revision}/LICENSE\n`;
}

/** What a profile, a proposal and the browser keep of a template: no text. */
export const templateRecord = (t) => ({
  kind: "agency",
  id: t.id,
  name: t.name,
  revision: t.revision,
  source: t.source,
  license: "MIT",
  verdict: t.scan.verdict,
  ...(t.scan.rules.length ? { rules: t.scan.rules } : {}),
});

/** What the browser shows before an agent is created from a template. */
export const templatePreview = (t) => ({
  ...templateRecord(t),
  category: t.category,
  description: t.description,
  instructions: t.instructions,
  findings: t.scan.findings,
});

export class AgencyTemplates {
  constructor(agency) {
    this.agency = agency;
  }
  /** One page of catalog entries (id, name, category) at the current revision. */
  async search(query = {}) {
    const q = typeof query.q === "string" ? query.q.slice(0, templateLimits.query) : "";
    const category = typeof query.category === "string" ? query.category : "";
    return searchCatalog(await this.agency.catalog(), { ...query, q, category });
  }
  /**
   * One entry at `revision` (the current one when omitted): its parsed identity,
   * the composed instructions, and the scan of the fetched file. Upstream model,
   * tool and permission fields are never read.
   */
  async template({ id, revision } = {}) {
    if (typeof id !== "string" || !idPattern.test(id))
      throw templateProblem("templateInvalid", 400);
    if (revision !== undefined && !revisionPattern.test(String(revision)))
      throw templateProblem("templateInvalid", 400);
    const pinned = revision ?? (await this.agency.catalog()).revision;
    const {
      raw,
      license: _license,
      ...agent
    } = await this.agency.entry({
      id,
      revision: pinned,
    });
    const scan = scanSkill([{ name: "AGENT.md", data: Buffer.from(raw), mode: 0o644 }]);
    const instructions = templateInstructions(agent);
    if (instructions.length > templateLimits.instructions)
      throw templateProblem("templateTooLarge", 422);
    return { ...agent, instructions, scan };
  }
}
