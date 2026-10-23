import { personalCapabilities, personalEligible } from "./native-capabilities.js";

// The capabilities a lead may share with its permanent members (lead-shares.js):
// Read images, so a member can look at the images of folders it works in.
export const shareableCapabilities = ["documents"];

/**
 * The capabilities `lead` shares with its permanent member `record` right now,
 * `{ documents: true }` or `{}`: a standing share row of this lead for this member
 * (assistant_lead_shares), counted only while the member is the lead's unarchived
 * permanent member and the lead, active and no member itself, holds the capability.
 * Resolved on every read (AssistantStore.resolved), never stored with the member.
 * Never throws.
 */
export function sharedCapabilities(db, record, lead) {
  if (
    !record.teamMemberId ||
    record.lifetime !== "permanent" ||
    record.archivedAt ||
    !lead ||
    lead.id !== record.parentAssistantId ||
    lead.teamMemberId ||
    !personalEligible(lead)
  )
    return {};
  let rows;
  try {
    rows = db
      .prepare("SELECT body FROM assistant_lead_shares WHERE member_assistant_id=?")
      .all(record.id)
      .map((row) => JSON.parse(row.body));
  } catch {
    // No shares table yet, or an unreadable row: nothing is shared.
    return {};
  }
  const held = personalCapabilities(lead);
  const out = {};
  for (const row of rows)
    if (
      row.kind === "capability" &&
      !row.requestId &&
      row.leadId === lead.id &&
      row.memberId === record.teamMemberId &&
      shareableCapabilities.includes(row.capability) &&
      held[row.capability] === true
    )
      out[row.capability] = true;
  return out;
}
