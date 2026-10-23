import { actionPath } from "./action-text.js";
import { grantedKeys } from "./member-grants.js";

/**
 * What a member gets, as the owner reads it in Telegram: one label per grant (a
 * named skill list as its count, never MCP server names beyond the count).
 */
export function grantLabels(grants = {}, m, servers = 0) {
  const labels = m.memberGrants.labels;
  return [
    ...grantedKeys(grants).map((key) =>
      key === "shell"
        ? labels.shell(m.memberGrants.levels[grants.shell] || grants.shell)
        : key === "skills"
          ? grants.skills === "all"
            ? labels.allSkills
            : labels.skills(grants.skills.length)
          : key === "projects"
            ? labels.projects(Object.keys(grants.projects).length)
            : key === "github"
              ? labels.github(m.memberGrants.githubLevels[grants.github])
              : labels[key],
    ),
    ...(servers ? [labels.mcpServers(servers)] : []),
  ];
}

/** Whether a set of grants holds shell or SSH, which the owner sees highlighted. */
export const holdsShellSsh = (grants = {}) => !!(grants.shell || grants.ssh);

// A lead's shell or SSH grant for a member: the owner decides in Telegram as well.
export function notifyMemberGrant(w, action, phase, key, m, target) {
  if (!["approval", "result"].includes(phase)) return;
  const p = action.payload;
  let lead = "";
  try {
    lead = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  const detail = [
    m.memberGrants.approval(lead, p.memberName),
    grantLabels(p.grants, m).join(", "),
    m.memberGrants.warning,
  ].join("\n\n");
  const text =
    phase === "approval"
      ? detail
      : `${m.memberGrants.states[action.state] || m.actionStates.unknown}\n\n${grantLabels(p.grants, m).join(", ")}`;
  const button = (decision, label) => ({
    proposalId: action.id,
    revision: action.revision,
    decision,
    label,
  });
  w.s.assistantChannels.outbox.enqueue({
    key,
    source: { ...target, actionId: action.id },
    kind: `action-${phase}`,
    localized: true,
    text,
    path: actionPath(action),
    actions:
      phase === "approval"
        ? [button("approve", m.memberGrants.approve), button("decline", m.actionDecline)]
        : [],
  });
}

// The chat note of a grant change or a decided shell or SSH grant, or of a reminder
// a member created on its lead (never its text).
export function grantNotes(a) {
  if (!a.chatNotes?.result) return [];
  const p = a.payload;
  if (p.action === "member_promote")
    return [
      {
        id: `member-promote:${a.id}`,
        role: "event",
        event: "member-promote",
        memberName: p.memberName,
        timestamp: a.chatNotes.result.at,
        runId: null,
      },
    ];
  if (p.action === "member_update")
    return [
      {
        id: `member-update:${a.id}`,
        role: "event",
        event: "member-update",
        memberName: p.memberName,
        ...(p.previousName ? { previousName: p.previousName } : {}),
        edited: p.edited,
        ...(p.model ? { model: p.model } : {}),
        timestamp: a.chatNotes.result.at,
        runId: null,
      },
    ];
  // A lead's summary of its member's chat, now or after its task (member-summaries.js).
  if (p.action === "member_summarise")
    return [
      {
        id: `member-summarise:${a.id}`,
        role: "event",
        event: "member-summarise",
        memberName: p.memberName,
        when: p.when,
        timestamp: a.chatNotes.result.at,
        runId: null,
      },
    ];
  if (p.action === "member_reminder")
    return [
      {
        id: `member-reminder:${a.id}`,
        role: "event",
        event: "member-reminder",
        memberName: p.memberName,
        timestamp: a.chatNotes.result.at,
        runId: null,
      },
    ];
  return [
    {
      id: `member-grant:${a.id}`,
      role: "event",
      event: "member-grant",
      memberName: p.memberName,
      by: p.approval ? "owner" : p.by,
      ...(p.approval
        ? { granted: grantedKeys(p.grants), shell: p.grants.shell || null }
        : p.revoked
          ? { revoked: p.revoked }
          : { granted: p.granted }),
      mcpServers: p.mcpServers || 0,
      state: a.chatNotes.result.state,
      timestamp: a.chatNotes.result.at,
      runId: null,
    },
  ];
}
