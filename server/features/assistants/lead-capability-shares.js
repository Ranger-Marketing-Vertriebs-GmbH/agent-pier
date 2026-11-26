import {
  ownSkills,
  personalCapabilities,
  personalEligible,
} from "./native-capabilities.js";
import { isUserAgent } from "../users/user-access.js";

// The capabilities a lead may share with its permanent members (lead-shares.js):
// Read images, so a member can look at the images of folders it works in.
export const shareableCapabilities = ["documents"];

/**
 * What `lead` shares with its permanent member `record` right now beyond access,
 * `{ capabilities, skills }`: `capabilities` is `{ documents: true }` or `{}`,
 * `skills` the sorted names of the lead's own skills it shares (AGENTPIER-499). Each
 * is a standing share row of this lead for this member (assistant_lead_shares),
 * counted only while the member is the lead's unarchived permanent member and the
 * lead, active and no member itself, holds the capability or has the skill switched
 * on. Skills never reach an agent of users. Resolved on every read
 * (AssistantStore.resolved), never stored with the member. Never throws.
 */
export function sharedByLead(db, record, lead) {
  const none = { capabilities: {}, skills: [] };
  if (
    !record.teamMemberId ||
    record.lifetime !== "permanent" ||
    record.archivedAt ||
    !lead ||
    lead.id !== record.parentAssistantId ||
    lead.teamMemberId ||
    !personalEligible(lead)
  )
    return none;
  let rows;
  try {
    rows = db
      .prepare("SELECT body FROM assistant_lead_shares WHERE member_assistant_id=?")
      .all(record.id)
      .map((row) => JSON.parse(row.body));
  } catch {
    // No shares table yet, or an unreadable row: nothing is shared.
    return none;
  }
  const held = personalCapabilities(lead);
  const on = ownSkills(lead);
  const capabilities = {};
  const skills = new Set();
  for (const row of rows) {
    if (row.requestId || row.leadId !== lead.id || row.memberId !== record.teamMemberId)
      continue;
    if (
      row.kind === "capability" &&
      shareableCapabilities.includes(row.capability) &&
      held[row.capability] === true
    )
      capabilities[row.capability] = true;
    if (row.kind === "skill" && on.includes(row.skill) && !isUserAgent(record))
      skills.add(row.skill);
  }
  return { capabilities, skills: [...skills].sort() };
}

/** The shared capabilities alone (sharedByLead). */
export const sharedCapabilities = (db, record, lead) =>
  sharedByLead(db, record, lead).capabilities;
