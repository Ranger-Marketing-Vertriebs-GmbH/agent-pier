import { Router } from "express";
import { catalogSource } from "../../features/assistants/agent-skills.js";
import {
  catalogUsers,
  switchOffEverywhere,
} from "../../features/assistants/catalog-switches.js";

// The owner's agent skill catalog (skill-catalog-wiring.js). These routes are owner
// only: route-access.js denies every path not listed for users.

const names = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string").slice(0, 32)
    : [];
const viewState = (record, { shadowedBy, unavailable }) =>
  record.damaged
    ? "damaged"
    : shadowedBy
      ? "shadowed"
      : record.needsSettings
        ? "needsSettings"
        : unavailable
          ? "unavailable"
          : "ready";

/**
 * A catalog record as the browser sees it: no paths, digests or source URL. With the
 * running Gateway's report (`entries`, by source) it carries the programs the skill
 * needs, `shadowed` when the runtime bundles the name (`shadowedBy` "bundled") or
 * reports it from another source ("source"), and `unavailable` when the report lacks
 * it or its last check failed (`failed`), as on the agent's Skills page; `agents` are
 * the agents that switch it on.
 */
export function catalogView(record, { entries, bundled, failed, agents } = {}) {
  const reported = entries?.filter((entry) => entry?.name === record.name) || [];
  const own = reported.find((entry) => entry.source === catalogSource);
  const shadowedBy = bundled?.has(record.name)
    ? "bundled"
    : reported.some((entry) => entry.source !== catalogSource)
      ? "source"
      : null;
  const unavailable = !!failed?.has(record.name) || (!!entries && !own);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    importKind: record.importKind,
    ...(record.origin ? { origin: record.origin } : {}),
    repository: Boolean(record.source?.url),
    scan: record.scan,
    needsSettings: record.needsSettings === true,
    state: viewState(record, { shadowedBy, unavailable }),
    ...(shadowedBy ? { shadowedBy } : {}),
    ...(own
      ? {
          requirements: {
            bins: names(own.requirements?.bins),
            anyBins: names(own.requirements?.anyBins),
          },
        }
      : {}),
    agents: agents || [],
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
}

/** The running Gateway's skills, or null without one or when it cannot answer. */
async function reportedEntries(runtime) {
  if (!runtime?.client?.ready) return null;
  try {
    const report = await runtime.client.call("skills.status", {});
    return Array.isArray(report?.skills) ? report.skills : null;
  } catch {
    return null;
  }
}

// A failing append is logged by its code, never turned into an error: the change
// itself already happened.
function appendQuietly(audit, event) {
  try {
    audit?.append(event);
  } catch (error) {
    console.error(
      `AgentPier could not audit ${event.action} (${error?.code || error?.message || "no code"}).`,
    );
  }
}

/** Ids and counts only: never a skill name, path, excerpt or content. */
function auditInstall(audit, { skill, scan, replaced }) {
  appendQuietly(audit, {
    action: replaced
      ? "extension.updated"
      : scan.overridden
        ? "extension.overridden"
        : "extension.installed",
    resourceType: "extension",
    resourceId: skill.id,
    source: "user",
    outcome: "success",
    details: {
      kind: "catalog-skill",
      verdict: scan.verdict,
      importKind: scan.importKind,
      scanRules: scan.rules,
      count: scan.findings,
      // An update is audited as one; whether it needed the override shows here.
      ...(replaced && scan.overridden ? { overridden: true } : {}),
    },
  });
}

export function agentSkillCatalogRoutes(services) {
  const { assistantSkillCatalog: catalog, assistants, audit } = services;
  const router = Router();
  router.get("/agent-skill-catalog", async (_req, res) => {
    const records = catalog.store.list();
    const entries = records.length ? await reportedEntries(assistants?.runtime) : null;
    const bundled = catalog.bundledNames();
    res.json({
      skills: records.map((record) =>
        catalogView(record, {
          entries,
          bundled,
          failed: catalog.store.failed,
          agents: assistants ? catalogUsers(assistants, record.name) : [],
        }),
      ),
    });
  });
  // Reads and scans an upload or GitHub link; nothing is written until confirmed.
  router.post("/agent-skill-catalog/skills/preview", async (req, res) =>
    res.json(await catalog.preview(req.body)),
  );
  router.post("/agent-skill-catalog/skills", async (req, res) => {
    const result = await catalog.install(req.body);
    auditInstall(audit, result);
    res.status(201).json({ skill: catalogView(result.skill), replaced: result.replaced });
  });
  // Downloads the skill's repository again: up to date, or a preview of the update.
  router.post("/agent-skill-catalog/skills/:skillId/check", async (req, res) =>
    res.json(await catalog.checkUpdate(req.params.skillId)),
  );
  router.delete("/agent-skill-catalog/skills/:skillId", async (req, res) => {
    // Switched off on every agent first, so no apply compiles a name being removed, and
    // again once it is gone (SkillCatalog.remove).
    const { record, switchedOff } = await catalog.remove(req.params.skillId, (name) =>
      assistants ? switchOffEverywhere(assistants, name) : Promise.resolve([]),
    );
    appendQuietly(audit, {
      action: "extension.deleted",
      resourceType: "extension",
      resourceId: record.id,
      source: "user",
      outcome: "success",
      details: { kind: "catalog-skill", count: switchedOff.length },
    });
    res.json({ removed: record.id, switchedOff });
  });
  return router;
}
