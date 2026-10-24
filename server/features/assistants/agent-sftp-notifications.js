import { formatBytes } from "../operations/backup-components.js";
import { actionPath, fenced } from "./action-text.js";
import { hasHiddenCharacters, hiddenCharacterSource } from "./agent-ssh-text.js";

// Telegram buttons only for a plan the owner can read in full there.
export const telegramPathLimit = 20;
const lists = ["create", "update", "delete", "deleteDirs"];
const hiddenAll = new RegExp(hiddenCharacterSource, "gu");
// A path as text: hidden characters as their code, so Telegram never draws them.
const visible = (text) =>
  String(text).replace(
    hiddenAll,
    (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
const count = (s, key) => (s[key]?.length ?? 0) + (s.more?.[key] ?? 0);

// Every path the card names: the targets and the plan's lists.
function cardPaths(p) {
  const s = p.summary || {};
  return [
    p.remotePath,
    p.toPath,
    p.local?.path,
    s.path,
    s.from,
    s.to,
    ...lists.flatMap((key) => s[key] || []),
  ].filter((value) => typeof value === "string");
}

/**
 * Whether Telegram may decide an SFTP card: every planned path is listed (nothing
 * cut), no list is longer than `telegramPathLimit`, and no path hides characters.
 */
export function sftpTelegramApprovable(payload) {
  const s = payload?.summary;
  if (!s) return false;
  const more = Object.values(s.more || {}).some((n) => n > 0) || s.moreDeleteDirs > 0;
  if (more || lists.some((key) => (s[key]?.length ?? 0) > telegramPathLimit))
    return false;
  return !cardPaths(payload).some(hasHiddenCharacters);
}

function outcome(a, m) {
  const state = m.sftpStates[a.state] || m.sftpStates.unknown;
  return a.state === "failed" && a.diagnostic ? `${state} · ${a.diagnostic}` : state;
}

function facts(w, action, m) {
  const p = action.payload;
  const s = p.summary || {};
  let agent = action.assistantId;
  try {
    agent = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  const transfer = Array.isArray(s.create);
  return [
    m.sshAgent(agent),
    ...(action.leadAssistantId ? [m.sshRequestedBy(action.memberName || agent)] : []),
    m.sshTarget(p.hostName, `${p.username}@${p.host}:${p.port}`),
    m.sftpOperation(m.sftpOperations[p.operation] || p.operation),
    m.sftpRemotePath(visible(p.remotePath)),
    ...(p.toPath ? [m.sftpToPath(visible(p.toPath))] : []),
    ...(p.local
      ? [m.sftpLocalPath(p.local.projectName || m.sftpWorkspace, visible(p.local.path))]
      : []),
    ...(transfer
      ? [
          m.sftpCounts(
            count(s, "create"),
            count(s, "update"),
            count(s, "delete") + count(s, "deleteDirs"),
          ),
          m.sftpSize(formatBytes(s.bytes || 0)),
          m.sftpOverwrites(s.overwrites || 0),
        ]
      : []),
  ].join("\n");
}

// The plan's paths, one fenced list per kind of change.
function paths(s, m) {
  return lists
    .filter((key) => s[key]?.length)
    .map((key) => `${m.sftpLists[key]}\n${fenced(s[key].join("\n"))}`);
}

/**
 * The approval and its result in the bound chat. The approval names the agent, the
 * host, the operation, both paths, the plan's counts, size and overwrites and, when
 * Telegram may decide it, every path; the result names the state.
 */
export function notifySftp(w, action, phase, key, m, target) {
  const p = action.payload;
  const approvable = sftpTelegramApprovable(p);
  const text =
    phase === "approval"
      ? [
          m.sftpApproval,
          facts(w, action, m),
          ...(approvable ? paths(p.summary, m) : [m.sftpOpenToApprove]),
        ].join("\n\n")
      : [outcome(action, m), facts(w, action, m)].join("\n\n");
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
      phase === "approval" && approvable
        ? [
            button("approve", m.sftpAllowOnce),
            ...(p.allowAlways ? [button("allow-always", m.sftpAllowAlways)] : []),
            button("decline", m.sftpDeny),
          ]
        : [],
  });
}
