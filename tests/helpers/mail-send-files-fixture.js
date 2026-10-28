import { createHash } from "node:crypto";
import { mailFilesFixture } from "./mail-files-fixture.js";
import { waitFor } from "./agent-ssh-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const owner = { kind: "owner", channel: "ui" };
const settledStates = ["completed", "failed", "unknown", "cancelled", "declined"];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The stable code a call fails with; a call that succeeds fails the test. */
export async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  throw new Error("the call succeeded");
}

/** Whether `raw` (an SMTP message) carries `bytes` as a base64 part. */
export const carries = (raw, bytes) =>
  raw.toString("latin1").replace(/\r?\n/g, "").includes(bytes.toString("base64"));

/**
 * mailFilesFixture with a send-level grant (`rules`, `shell`, `projectFiles`), the
 * Drafts, Trash and Sent folders, and short holds: `send` and `draft` call the tool
 * on the owner's own turn, `decide` approves or declines a card as the owner,
 * `settled` waits for a row's outcome and `count` counts a folder's messages.
 */
export async function sendFilesFixture(
  t,
  { rules, shell = "off", projectFiles = {} } = {},
) {
  const f = await mailFilesFixture(t);
  const grant = (extra = {}) =>
    f.access({ level: "send", recipients: rules, shell, projectFiles, ...extra });
  grant();
  f.imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
  f.imap.mailbox.add("Trash", { specialUse: "\\Trash" });
  f.imap.mailbox.add("Sent", { specialUse: "\\Sent" });
  f.workflows.mail.sends.pollMs = 10;
  f.workflows.mail.sends.holdMs = 30;
  const fields = {
    to: ["bob@example.org"],
    subject: "Offer",
    body: "See attached.",
  };
  const send = (input = {}, inv) =>
    f.mail(
      {
        accountId: f.account.id,
        action: "send",
        ...(input.draftUid === undefined && fields),
        ...input,
      },
      inv,
    );
  const draft = (input = {}, inv) =>
    f.mail({ accountId: f.account.id, action: "draft", ...fields, ...input }, inv);
  const decide = (id, decision = "approve") => {
    const a = f.workflows.get(id);
    return f.workflows.decide(id, { decision, revision: a.revision }, owner);
  };
  const settled = (id) =>
    waitFor(() => {
      const a = f.workflows.get(id);
      return settledStates.includes(a.state) && a;
    });
  const count = (path) => f.imap.folder(path).messages.length;
  const sent = () => f.audit.filter((e) => e.action === "mail.sent");
  return { ...f, grant, fields, send, draft, decide, settled, count, sent };
}
