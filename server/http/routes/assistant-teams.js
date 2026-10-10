import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
export function assistantTeamRoutes({ assistants }) {
  const router = Router();
  const service = () => {
    if (!assistants.teams) throw assistantProblem("unavailable", 503);
    return assistants.teams;
  };
  const revision = (body) => {
    if (
      !body ||
      Object.keys(body).some((k) => k !== "revision") ||
      !Number.isSafeInteger(body.revision)
    )
      throw assistantProblem("invalid");
    return body.revision;
  };
  router.get("/assistant-teams", (_req, res) => res.json(service().list()));
  router.put("/assistants/:id/team-policy", (req, res) => {
    const { revision, ...input } = req.body;
    const result = service().store.savePolicy(req.params.id, input, revision);
    assistants.changed();
    res.json(result);
  });
  router.put("/assistant-team-settings", (req, res) => {
    const { revision, ...input } = req.body;
    const result = service().store.saveSettings(input, revision);
    assistants.config.reset?.();
    assistants.changed();
    res.json(result);
  });
  router.post("/assistant-team-proposals/:id/decision", (req, res) =>
    res.json(service().decide(req.params.id, req.body, { kind: "owner", channel: "ui" })),
  );
  router.post("/assistant-team-members/:id/recover", async (req, res) =>
    res.json(await service().recoverMember(req.params.id, req.body)),
  );
  for (const kind of ["teams", "team-members"]) {
    router.post(`/assistant-${kind}/:id/stop`, async (req, res) => {
      if (Object.keys(req.body || {}).length) throw assistantProblem("invalid");
      const s = service(),
        record = s.store.get(req.params.id);
      if (record.kind !== (kind === "teams" ? "team" : "member"))
        throw assistantProblem("notFound", 404);
      res.json(
        await s.stop(
          record.teamId || record.id,
          record.kind === "member" ? record.id : undefined,
        ),
      );
    });
    for (const action of kind === "teams"
      ? ["archive", "restore"]
      : ["promote", "archive", "restore"])
      router.post(`/assistant-${kind}/:id/${action}`, async (req, res) => {
        const s = service(),
          record = s.store.get(req.params.id);
        if (record.kind !== (kind === "teams" ? "team" : "member"))
          throw assistantProblem("notFound", 404);
        const result = await s.lifecycle(action, record.id, revision(req.body));
        assistants.changed();
        res.json(s.project(result));
      });
  }
  return router;
}
