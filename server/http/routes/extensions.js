import { Router } from "express";

/**
 * The owner's decision on a scanned skill import: installed (no finding or accepted
 * warnings) or overridden (a blocking scan). Rule ids and counts only, never content.
 * A failing append is logged and never turns the finished install into an error.
 */
function auditSkillDecision(audit, skill) {
  const action = skill.scan.overridden ? "extension.overridden" : "extension.installed";
  try {
    audit?.append({
      action,
      resourceType: "extension",
      resourceId: skill.id,
      source: "user",
      outcome: "success",
      details: {
        kind: "skill-import",
        verdict: skill.scan.verdict,
        importKind: skill.scan.importKind,
        scanRules: skill.scan.rules,
        count: skill.scan.findings,
      },
    });
  } catch (error) {
    console.error(
      `AgentPier could not audit ${action} (${error?.code || error?.message || "no code"}).`,
    );
  }
}

export function extensionsRoutes(services) {
  const { extensions } = services;
  const router = Router();
  router.post("/accounts/:id/extensions/share", (req, res) =>
    res.json(services.sharedProfiles.migrate(req.params.id)),
  );
  router.get("/accounts/:id/extensions", async (req, res) =>
    res.json(await extensions.list(req.params.id)),
  );
  // Reads and scans an upload or GitHub link; nothing is written until confirmed.
  router.post("/accounts/:id/extensions/skills/preview", async (req, res) =>
    res.json(await extensions.previewSkill(req.params.id, req.body)),
  );
  router.post("/accounts/:id/extensions/skills", async (req, res) => {
    const skill = await extensions.installSkill(req.params.id, req.body);
    auditSkillDecision(services.audit, skill);
    res.status(201).json(skill);
  });
  router.delete("/accounts/:id/extensions/skills/:skillId", async (req, res) => {
    await extensions.removeSkill(req.params.id, req.params.skillId);
    res.status(204).end();
  });
  return router;
}
