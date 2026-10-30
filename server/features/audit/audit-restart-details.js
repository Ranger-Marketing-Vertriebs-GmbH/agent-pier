// A main chat restart (main-chat-restart.js): how many chats and members it affected
// and the work it stopped, counts only; never a chat, member or turn id.
const workKinds = [
  "turns",
  "teams",
  "members",
  "requests",
  "coding",
  "goals",
  "approvals",
];
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function restartAuditDetails(details, event) {
  if (count(details.chats)) event.details.chats = details.chats;
  const members = details.members || {};
  if (count(members.ended) && count(members.restarted))
    event.details.members = { ended: members.ended, restarted: members.restarted };
  const work = details.work || {};
  if (workKinds.every((kind) => count(work[kind])))
    event.details.work = Object.fromEntries(workKinds.map((kind) => [kind, work[kind]]));
}
