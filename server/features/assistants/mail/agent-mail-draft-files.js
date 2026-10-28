import { assistantProblem } from "../assistant-validation.js";
import { mailError } from "../../mail/mail-connection.js";
import { openFolder, resolveFolders } from "../../mail/mail-folders.js";
import { attachmentsOf, fileName } from "../../mail/mail-messages.js";
import { attachmentLimits } from "../../mail/mail-parts.js";
import { saveDraft, trashDraft } from "../../mail/mail-changes.js";
import {
  fileContext,
  readSources,
  sourceAllowed,
  storedFiles,
} from "./agent-mail-sources.js";
import { cardAttachments } from "./agent-mail-card.js";

// Where an agent's draft attachments came from. A file an agent attached with a
// `draft` call is stored in the draft itself; this table remembers, per draft
// (account and Message-ID) and raw part digest, the file's source (workspace,
// project or host path) and the turn's file context, so a later `send` of that
// draft shows the owner the path and checks the source again at approval. A part
// without a row is the draft's own (`kind: "draft"`). Rows older than 30 days go on
// every `record`; agent-deletion.js removes an agent's rows, AgentMail.revokeAccount
// an account's.

const keepMs = 30 * 86400000;

export function mailDraftFilesTable(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS agent_mail_draft_files(account_id TEXT NOT NULL,message_id TEXT NOT NULL,part_sha256 TEXT NOT NULL,assistant_id TEXT NOT NULL,source TEXT NOT NULL,files TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,message_id,part_sha256,assistant_id))",
  );
}

export class MailDraftFiles {
  constructor(db, now = () => Date.now()) {
    Object.assign(this, { db, now });
    mailDraftFilesTable(db);
  }
  /** Remembers `entries` ({ partSha256, source, files }) of a saved draft. */
  record(accountId, messageId, assistantId, entries) {
    const now = this.now();
    this.prune(now);
    if (!messageId || !entries.length) return;
    const insert = this.db.prepare(
      "INSERT INTO agent_mail_draft_files(account_id,message_id,part_sha256,assistant_id,source,files,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,message_id,part_sha256,assistant_id) DO UPDATE SET source=excluded.source,files=excluded.files,created_at=excluded.created_at",
    );
    for (const { partSha256, source, files } of entries)
      insert.run(
        accountId,
        messageId,
        partSha256,
        assistantId,
        JSON.stringify(source),
        JSON.stringify(files),
        now,
      );
  }
  /** The draft's remembered parts: Map<partSha256, { source, files }>. */
  lookup(accountId, messageId, assistantId) {
    const found = new Map();
    if (!messageId) return found;
    const rows = this.db
      .prepare(
        "SELECT part_sha256,source,files FROM agent_mail_draft_files WHERE account_id=? AND message_id=? AND assistant_id=?",
      )
      .all(accountId, messageId, assistantId);
    for (const row of rows)
      try {
        found.set(row.part_sha256, {
          source: JSON.parse(row.source),
          files: JSON.parse(row.files),
        });
      } catch {}
    return found;
  }
  /**
   * Copies the rows of `partSha256s` from a replaced draft to its successor, with
   * `assistantId` only that agent's rows.
   */
  carry(accountId, fromMessageId, toMessageId, partSha256s, assistantId) {
    if (!fromMessageId || !toMessageId || !partSha256s.length) return;
    const wanted = new Set(partSha256s);
    const rows = this.db
      .prepare(
        "SELECT part_sha256,assistant_id,source,files FROM agent_mail_draft_files WHERE account_id=? AND message_id=?",
      )
      .all(accountId, fromMessageId)
      .filter(
        (row) =>
          wanted.has(row.part_sha256) &&
          (assistantId === undefined || row.assistant_id === assistantId),
      );
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO agent_mail_draft_files(account_id,message_id,part_sha256,assistant_id,source,files,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const now = this.now();
    for (const row of rows)
      insert.run(
        accountId,
        toMessageId,
        row.part_sha256,
        row.assistant_id,
        row.source,
        row.files,
        now,
      );
  }
  removeAccount(accountId) {
    this.db
      .prepare("DELETE FROM agent_mail_draft_files WHERE account_id=?")
      .run(accountId);
  }
  prune(now = this.now()) {
    this.db
      .prepare("DELETE FROM agent_mail_draft_files WHERE created_at<?")
      .run(now - keepMs);
  }
}

const invalid = () => assistantProblem("invalid");
const controls = /[\u0000-\u001f\u007f]/;

/** `removeAttachments`: names without control characters, none twice. */
export function removeList(names) {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.length > attachmentLimits.files) throw invalid();
  if (names.some((n) => typeof n !== "string" || !n || controls.test(n))) throw invalid();
  if (new Set(names).size !== names.length) throw invalid();
  return names;
}

/**
 * The listed files read for the turn (fileContext), outside any IMAP connection and
 * before a draft is saved, within `limits.attachments.mailBytes` (AgentMail.limits): `{ files, read, entries }`
 * with `files` the turn's file context, `read` as readSources and `entries` what
 * saveDraft attaches ({ filename, content, contentType }) in list order; null for
 * no files.
 */
export async function captureFiles(w, limits, inv, caller, list) {
  if (!list.length) return null;
  const files = fileContext(w, inv, caller);
  const read = await readSources(w, files, list, {
    maxBytes: limits.attachments.mailBytes,
  });
  return {
    files,
    read,
    entries: read.map((r) => ({
      filename: r.name,
      content: r.bytes,
      contentType: r.type,
    })),
  };
}

/**
 * The provenance rows of the new files in a saved draft. The read-back `attachments`
 * are the kept parts first, then the new files, so the new ones are the last
 * `read.length` entries (with `replaceUid` offset by the kept count); each must hold
 * exactly the bytes read, or the draft cannot prove what it carries (MAIL_PROTOCOL).
 */
export function newFileEntries(attachments, captured) {
  if (!captured) return [];
  const { read } = captured;
  if (!attachments || attachments.length < read.length) throw mailError("MAIL_PROTOCOL");
  const added = attachments.slice(attachments.length - read.length);
  if (added.some((a, i) => a.sha256 !== read[i].sha256)) throw mailError("MAIL_PROTOCOL");
  const files = storedFiles(captured.files);
  return added.map((a, i) => ({
    partSha256: a.partSha256,
    source: read[i].source,
    files,
  }));
}

/**
 * The card attachments of a draft a `send` saved with `captured` files (all of them
 * new), recorded as the agent's so a later send of the draft names them too.
 */
export function savedAttachments(mail, accountId, agentId, saved, captured) {
  if (!captured) return [];
  const entries = newFileEntries(saved.attachments, captured);
  mail.draftFiles.record(accountId, saved.messageId, agentId, entries);
  return cardAttachments(saved.attachments, (_p, i) => entries[i]?.source);
}

/**
 * The card attachments of a stored draft (loadDraft) and the file context they are
 * checked against: parts an agent's `draft` call attached carry their recorded
 * source, which must still be within reach of both that call and this turn; all
 * others are the draft's own. `files` is this turn's file context (fileContext), null
 * without such parts. More than `attachmentLimits.files` parts is invalid.
 */
export function storedDraftAttachments(mail, inv, caller, accountId, draft) {
  const parts = draft.attachments ?? [];
  if (parts.length > attachmentLimits.files) throw invalid();
  const agentId = caller.assistant.id;
  const recorded = mail.draftFiles.lookup(accountId, draft.messageId, agentId);
  const found = parts.map((p) => recorded.get(p.partSha256) ?? null);
  if (!found.some(Boolean)) return { attachments: cardAttachments(parts), files: null };
  // The card keeps only this turn's file context, and approval re-checks against it
  // alone. That suffices: the bytes are already in the draft and bound to the card
  // by their digests, the draft-time context is checked once here, and whatever
  // the agent loses later (a project, Full access, a hook's rights) is lost from
  // its current access too, so approval still cancels the card.
  const files = fileContext(mail.w, inv, caller);
  const turn = storedFiles(files);
  for (const entry of found)
    if (
      entry &&
      !(
        sourceAllowed(mail.w, agentId, entry.files, entry.source) &&
        sourceAllowed(mail.w, agentId, turn, entry.source)
      )
    )
      throw assistantProblem("mailSourceRefused", 403);
  return { attachments: cardAttachments(parts, (_p, i) => found[i]?.source), files };
}

// The Message-ID and attachment names of draft `uid`, read before it is replaced.
async function draftHead(client, uid) {
  const { drafts } = await resolveFolders(client);
  if (!drafts) throw mailError("MAIL_NO_DRAFTS");
  await openFolder(client, drafts);
  const row = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, bodyStructure: true },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  return {
    messageId: row.envelope?.messageId ?? null,
    names: attachmentsOf(row.bodyStructure).map(fileName),
  };
}

/**
 * An agent's `draft` on one IMAP connection: with `replaceUid` the old draft's
 * attachments kept (all but `removeNames`) and the new files together at most
 * `attachmentLimits.files`, then saveDraft; the new files' sources are recorded and
 * those of the kept parts carried over from the old draft's Message-ID.
 */
export async function saveAgentDraft(mail, client, gate, sender, request, captured) {
  const { account } = gate;
  const added = captured?.read.length ?? 0;
  let old = null;
  if (request.replaceUid !== undefined) {
    old = await draftHead(client, request.replaceUid);
    const kept = old.names.filter((n) => !request.removeNames.includes(n)).length;
    if (kept + added > attachmentLimits.files) throw invalid();
  }
  const saved = await saveDraft(client, sender, request.fields, {
    replaceUid: request.replaceUid,
    files: captured?.entries ?? [],
    removeNames: request.removeNames,
  });
  if (!saved.attachments) {
    if (!captured) return saved;
    // Stored but not read back: the files' sources could not be recorded, so the
    // new draft goes to Trash again and the call fails, as a send's would.
    const trashed = saved.draftUid ? await trashDraft(client, saved.draftUid) : false;
    throw Object.assign(mailError("MAIL_PROTOCOL"), { draftTrashed: trashed });
  }
  const entries = newFileEntries(saved.attachments, captured);
  mail.draftFiles.record(account.id, saved.messageId, gate.agent.id, entries);
  if (old)
    mail.draftFiles.carry(
      account.id,
      old.messageId,
      saved.messageId,
      saved.attachments
        .slice(0, saved.attachments.length - added)
        .map((a) => a.partSha256),
      gate.agent.id,
    );
  return saved;
}
