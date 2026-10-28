import { assistantProblem } from "../assistant-validation.js";
import { draftFields } from "../../mail/mail-compose.js";
import { mailBounds } from "../../mail/mail-messages.js";
import { clipText } from "../../mail/mail-text.js";
import { markMessages, moveMessages, trashMessages } from "../../mail/mail-changes.js";
import { attachmentList } from "./agent-mail-send-input.js";
import { captureFiles, removeList, saveAgentDraft } from "./agent-mail-draft-files.js";

// The changing actions of agentpier_mail: mark, move, delete (to Trash only) and
// draft. They need no approval in any turn the gate lets through; only a delete (a
// move into Trash, or a replaced draft going there) is audited, with the agent, the account and a count.

const selection = ["folder", "uid", "uids"];
const fields = {
  mark: [...selection, "flag"],
  move: [...selection, "destination"],
  delete: selection,
  draft: [
    "to",
    "cc",
    "bcc",
    "subject",
    "body",
    "replyToUid",
    "replyToFolder",
    "draftUid",
    "attachments",
    "removeAttachments",
  ],
};
const controls = /[\x00-\x1f\x7f]/;

export const changingActions = Object.keys(fields);

const invalid = () => assistantProblem("invalid");

// `uid` or `uids` (not both), without duplicates.
function uidsOf(input) {
  if ((input.uid === undefined) === (input.uids === undefined)) throw invalid();
  const uids = input.uids ?? [input.uid];
  if (!uids.length) throw invalid();
  return [...new Set(uids)];
}

/** The action's own fields, checked beyond the tool schema. */
export function changingInput(input) {
  const allowed = new Set(["action", "accountId", ...fields[input.action]]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw invalid();
  if (input.action === "draft") {
    // Removing attachments needs the draft they are in.
    if (input.removeAttachments !== undefined && input.draftUid === undefined)
      throw invalid();
    return {
      action: "draft",
      fields: draftFields(input),
      replaceUid: input.draftUid,
      attachments: attachmentList(input.attachments),
      removeNames: removeList(input.removeAttachments),
    };
  }
  const folder = input.folder ?? "INBOX";
  if (controls.test(folder)) throw invalid();
  const request = { action: input.action, folder, uids: uidsOf(input) };
  if (input.action === "mark") {
    if (!input.flag) throw invalid();
    return { ...request, flag: input.flag };
  }
  if (input.action === "move") {
    if (!input.destination || controls.test(input.destination)) throw invalid();
    return { ...request, destination: input.destination };
  }
  return request;
}

export function auditDelete(services, gate, count) {
  try {
    services.audit?.append({
      action: "mail.deleted",
      resourceType: "mail",
      resourceId: gate.account.id,
      source: "system",
      outcome: "success",
      details: { kind: "message", assistantId: gate.agent.id, count },
    });
  } catch (error) {
    console.error("Agent mail audit failed:", error?.code || "error");
  }
}

/**
 * Runs one changing action for the gated agent on one IMAP connection. A draft's
 * files are read first, outside it, for the call `inv` with the workflows `w`;
 * `mail` (AgentMail) gives the size limits and records where the files came from.
 */
export async function runChanging({ accounts, services, inv, w, mail }, gate, input) {
  const request = changingInput(input);
  const { account } = gate;
  const captured =
    request.action === "draft"
      ? await captureFiles(w, mail.limits, inv, gate.caller, request.attachments)
      : null;
  const run = (fn) =>
    accounts.withImap(account.id, fn).catch((error) => {
      // A draft that could not be read back went to Trash again.
      if (error?.draftTrashed) auditDelete(services, gate, 1);
      throw error;
    });
  const result = await run(async (client) => {
    if (request.action === "mark")
      return markMessages(client, request.folder, request.uids, request.flag);
    if (request.action === "delete")
      return trashMessages(client, request.folder, request.uids);
    if (request.action === "move") {
      const { trash, ...moved } = await moveMessages(
        client,
        request.folder,
        request.uids,
        request.destination,
      );
      return { ...moved, deleted: trash === true };
    }
    const sender = {
      address: account.address,
      displayName: accounts.get(account.id).displayName,
    };
    const {
      folder,
      thread: _thread,
      htmlPart: _html,
      attachments,
      ...draft
    } = await saveAgentDraft(mail, client, gate, sender, request, captured);
    return {
      draftFolder: folder,
      ...draft,
      attachments:
        attachments?.map(({ name, size, type }) => ({
          name: clipText(name ?? "", mailBounds.nameChars).text || null,
          size,
          type,
        })) ?? null,
    };
  });
  if (request.action === "delete" && result.moved)
    auditDelete(services, gate, result.moved);
  if (request.action === "move" && result.deleted && result.moved)
    auditDelete(services, gate, result.moved);
  // The replaced draft went to Trash.
  if (request.action === "draft" && result.replaced) auditDelete(services, gate, 1);
  const { deleted: _deleted, draftFolder, ...rest } = result;
  return {
    accountId: account.id,
    account: account.name,
    folder: draftFolder ?? request.folder,
    ...rest,
  };
}
