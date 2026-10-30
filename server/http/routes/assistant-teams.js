import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { followLead } from "../../features/assistants/member-follow.js";
import { replacedInstructions } from "../../features/assistants/member-edits.js";
import { groupKind, publicGroup } from "../../features/assistants/member-groups.js";
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
    service().grants?.settingOff(req.params.id);
    followLead(assistants, req.params.id);
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
  // A member's whole report; team lists carry an excerpt.
  router.get("/assistant-teams/:id/reports/:memberId", (req, res) =>
    res.json(service().report(req.params.id, req.params.memberId)),
  );
  // The instructions a lead's edit replaced, for the owner only: never in team lists.
  router.get("/assistant-team-members/:id/replaced/:entryId", (req, res) =>
    res.json(replacedInstructions(service().store, req.params.id, req.params.entryId)),
  );
  // A lead's question or task for a member: the owner reads or cancels it.
  router.get("/assistant-lead-requests/:id", (req, res) =>
    res.json(service().requestDetail(req.params.id)),
  );
  router.post("/assistant-lead-requests/:id/cancel", async (req, res) => {
    if (Object.keys(req.body || {}).length) throw assistantProblem("invalid");
    res.json(await service().cancelRequest(req.params.id));
  });
  // The owner's changes to a lead's groups of permanent members (member-groups.js).
  const only = (body, keys) => {
    if (!body || Object.keys(body).some((k) => !keys.includes(k)))
      throw assistantProblem("invalid");
    return body;
  };
  const groupOf = (id) => {
    const record = service().store.find(id);
    if (record?.kind !== groupKind) throw assistantProblem("memberGroupNotFound", 404);
    return record;
  };
  router.post("/assistants/:id/member-groups", (req, res) =>
    res.json(
      publicGroup(
        service().ownerGroups("create", req.params.id, only(req.body, ["name"]).name),
      ),
    ),
  );
  router.patch("/assistant-member-groups/:id", (req, res) => {
    const group = groupOf(req.params.id);
    const { name } = only(req.body, ["name"]);
    res.json(
      publicGroup(
        service().ownerGroups("rename", group.parentAssistantId, group.id, name),
      ),
    );
  });
  router.delete("/assistant-member-groups/:id", (req, res) => {
    const group = groupOf(req.params.id);
    service().ownerGroups("remove", group.parentAssistantId, group.id);
    res.json({ deleted: group.id });
  });
  // Into a group (`groupId`), or out of its group with null; one atomic move.
  router.put("/assistant-team-members/:id/group", (req, res) => {
    const { groupId } = only(req.body, ["groupId"]);
    if (groupId !== null && typeof groupId !== "string")
      throw assistantProblem("invalid");
    const member = service().store.member(req.params.id);
    res.json(service().ownerGroups("move", member.parentAssistantId, member.id, groupId));
  });
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
