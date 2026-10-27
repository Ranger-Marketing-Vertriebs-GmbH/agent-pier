import { assistantProblem } from "../assistant-validation.js";
import { draftFields } from "../../mail/mail-compose.js";
import {
  markMessages,
  moveMessages,
  saveDraft,
  trashMessages,
} from "../../mail/mail-changes.js";

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
  if (input.action === "draft")
    return { action: "draft", fields: draftFields(input), replaceUid: input.draftUid };
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

/** Runs one changing action for the gated agent on one IMAP connection. */
export async function runChanging({ accounts, services }, gate, input) {
  const request = changingInput(input);
  const { account } = gate;
  const result = await accounts.withImap(account.id, async (client) => {
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
      ...draft
    } = await saveDraft(client, sender, request.fields, {
      replaceUid: request.replaceUid,
    });
    return { draftFolder: folder, ...draft };
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
