import { Router } from "express";

// The owner's agent skill catalog (skill-catalog-wiring.js). These routes are owner
// only: route-access.js denies every path not listed for users.

/** A catalog record as the browser sees it: no paths, digests or source URL. */
export function catalogView(record) {
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
    state: record.damaged ? "damaged" : record.needsSettings ? "needsSettings" : "ready",
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
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
    },
  });
}

export function agentSkillCatalogRoutes(services) {
  const { assistantSkillCatalog: catalog, audit } = services;
  const router = Router();
  router.get("/agent-skill-catalog", (_req, res) =>
    res.json({ skills: catalog.store.list().map(catalogView) }),
  );
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
    const record = await catalog.remove(req.params.skillId);
    const switchedOff = [];
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
