// What the browser and a lead's tools see of a team or a member record.
// Drafts show their MCP servers by name with the stdio marker, never their ids. A
// list that cannot be read is marked unavailable instead of shown short.
const servers = (ids, describe) => {
  if (!ids?.length) return {};
  const list = describe(ids);
  return list ? { mcpServers: list } : { mcpServersUnavailable: true };
};
const publicDraft = (
  { mcpServerIds, templateInstructions: _instructions, ...draft },
  describe,
) => ({
  ...draft,
  ...servers(mcpServerIds, describe),
});
export function publicTeam(record, describe = () => []) {
  const keys =
    record.kind === "member"
      ? [
          "id",
          "kind",
          "revision",
          "teamId",
          "parentAssistantId",
          "assistantId",
          "name",
          "role",
          "assignment",
          "lifetime",
          "phase",
          "conversationId",
          "attemptId",
          "archivedAt",
          "diagnostic",
          // What the lead granted, and its later changes (member-grant-requests.js).
          "grants",
          "grantLog",
          // The Agency template it came from, without its text.
          "template",
        ]
      : [
          "id",
          "kind",
          "revision",
          "parentAssistantId",
          "parentConversationId",
          "objective",
          "members",
          "memberIds",
          "phase",
          "lifetime",
          "archivedAt",
          "createdAt",
          "startedAt",
          "finishedAt",
          "resultState",
          "resultDiagnostic",
          "resultBatch",
        ];
  return {
    ...Object.fromEntries(keys.filter((k) => k in record).map((k) => [k, record[k]])),
    ...(record.kind === "member"
      ? servers(record.mcpServerIds, describe)
      : Array.isArray(record.members)
        ? { members: record.members.map((m) => publicDraft(m, describe)) }
        : {}),
    inheritedRevision: record.snapshot?.parentRevision,
    // Task members of this team may use the lead's shell and SSH (Work tab setting).
    ...(record.kind === "team"
      ? { memberShellSsh: record.policy?.memberShellSsh === true }
      : {}),
    // The owner's own words that started this team, shown beside it.
    ...(record.authorization?.source === "ownerRequest"
      ? { ownerRequestQuote: record.authorization.ownerRequestQuote }
      : {}),
  };
}
