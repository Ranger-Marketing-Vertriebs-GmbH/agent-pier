import { randomUUID, randomBytes, createHash } from "node:crypto";
import { assistantProblem, textValue } from "../assistants/assistant-validation.js";
import { telegramParts } from "./telegram-format.js";
const terminal = new Set(["delivered", "reviewed"]);
export class ChannelOutbox {
  /**
   * `link(channelId, path)` resolves an AgentPier path to {url,label}, or null
   * when no AgentPier address is configured for the channel.
   */
  constructor(db, { link = () => null } = {}) {
    this.db = db;
    this.link = link;
    db.exec(
      "CREATE TABLE IF NOT EXISTS channel_outbox(id TEXT PRIMARY KEY, operation_key TEXT UNIQUE NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id), state TEXT NOT NULL, body TEXT NOT NULL)",
    );
    for (const e of this.all())
      if (e.state === "delivering")
        this.transition(e.id, e.state, {
          state: "delivery_uncertain",
          diagnostic: "DELIVERY_UNCERTAIN",
        });
  }
  all(channelId) {
    return this.db
      .prepare(
        `SELECT body FROM channel_outbox${channelId ? " WHERE channel_id=?" : ""} ORDER BY rowid`,
      )
      .all(...(channelId ? [channelId] : []))
      .map((r) => JSON.parse(r.body));
  }
  get(id) {
    const row = this.db.prepare("SELECT body FROM channel_outbox WHERE id=?").get(id);
    if (!row) throw assistantProblem("notFound", 404);
    return JSON.parse(row.body);
  }
  pending(channelId) {
    return this.all(channelId).filter((e) => !terminal.has(e.state));
  }
  // `path` is the AgentPier page the notice links back to. The link is resolved
  // once and kept with the entry; it is not part of the operation fingerprint.
  // `localized` marks AgentPier-written text whose wording and button labels
  // depend on the channel language; they stay out of the fingerprint so a later
  // language change cannot conflict with an already stored notice.
  // `caption` is the plain caption of a shared file (kind "file", telegram-file.js).
  enqueue({
    key,
    source,
    kind,
    text,
    actions = [],
    teamId,
    path,
    localized = false,
    caption,
  }) {
    textValue(key, 200);
    // Full team assignments or a 65536-character task plus approval metadata.
    textValue(text, ["team-approval", "action-approval"].includes(kind) ? 80000 : 65536);
    for (const k of ["channelId", "chatId", "userId"]) textValue(source?.[k], 100);
    const hash = createHash("sha256")
      .update(
        JSON.stringify(
          localized
            ? {
                source,
                kind,
                teamId,
                actions: actions.map(({ label: _label, ...action }) => action),
              }
            : { source, kind, text, actions, teamId },
        ),
      )
      .digest("hex");
    const old = this.db
      .prepare("SELECT id FROM channel_outbox WHERE operation_key=?")
      .get(key);
    if (old) {
      const e = this.get(old.id);
      if (e.fingerprint !== hash) throw assistantProblem("conflict", 409);
      return e;
    }
    const link = path ? this.link(source.channelId, path) : null;
    const entry = {
      id: randomUUID(),
      key,
      source,
      channelId: source.channelId,
      chatId: source.chatId,
      userId: source.userId,
      kind,
      teamId,
      text,
      ...(typeof caption === "string" ? { caption } : {}),
      state: "outbound",
      link,
      parts: telegramParts(text, link),
      remoteMessageIds: [],
      nextDeliveryAt: 0,
      actions: actions.map((a) => ({
        ...a,
        handle: randomBytes(24).toString("base64url"),
        expiresAt: Date.now() + 86400000,
      })),
      fingerprint: hash,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO channel_outbox VALUES(?,?,?,?,?)")
      .run(entry.id, key, source.channelId, entry.state, JSON.stringify(entry));
    return entry;
  }
  /**
   * Clears the text of notices about the given actions, with secure_delete; ones not
   * delivered yet are never sent. Text already delivered stays in Telegram.
   */
  redactActions(actionIds) {
    this.overwrite(this.about(actionIds), (e) => ({
      ...e,
      text: "",
      parts: [],
      diagnostic: "MEMORY_FORGOTTEN",
      state: terminal.has(e.state) ? e.state : "reviewed",
    }));
  }
  /**
   * Rewrites the text of notices about the given actions with `rewrite` (SSH approvals
   * with secrets redacted), with secure_delete. Text already delivered stays in
   * Telegram; an entry still to be sent goes out rewritten.
   */
  rewriteActions(actionIds, rewrite) {
    this.overwrite(
      this.about(actionIds).filter((e) => e.text && rewrite(e.text) !== e.text),
      (e) => {
        const text = rewrite(e.text);
        return { ...e, text, parts: telegramParts(text, e.link) };
      },
    );
  }
  about(actionIds) {
    const ids = [...new Set(actionIds)];
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT body FROM channel_outbox WHERE json_extract(body,'$.source.actionId') IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids)
      .map((r) => JSON.parse(r.body))
      .filter((e) => e.text || e.parts?.length);
  }
  overwrite(rows, next) {
    if (!rows.length) return;
    const previous = this.db.prepare("PRAGMA secure_delete").get().secure_delete;
    this.db.exec("PRAGMA secure_delete=ON");
    try {
      for (const e of rows) {
        const row = next(e);
        this.db
          .prepare("UPDATE channel_outbox SET state=?,body=? WHERE id=?")
          .run(row.state, JSON.stringify(row), e.id);
      }
      this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      this.db.exec(`PRAGMA secure_delete=${previous ? "ON" : "OFF"}`);
    }
  }
  transition(id, expected, patch) {
    const e = this.get(id);
    if (e.state !== expected) throw assistantProblem("conflict", 409);
    const next = {
      ...e,
      ...patch,
      id: e.id,
      source: e.source,
      channelId: e.channelId,
      chatId: e.chatId,
      userId: e.userId,
    };
    if (
      !this.db
        .prepare("UPDATE channel_outbox SET state=?,body=? WHERE id=? AND state=?")
        .run(next.state, JSON.stringify(next), id, expected).changes
    )
      throw assistantProblem("conflict", 409);
    return next;
  }
  public(channelId) {
    const all = this.all(channelId),
      visible = new Map(
        [...all.filter((e) => !terminal.has(e.state)), ...all.slice(-100)].map((e) => [
          e.id,
          e,
        ]),
      );
    return [...visible.values()].map(
      ({ id, kind, state, text, diagnostic, createdAt, remoteMessageIds }) => ({
        id,
        kind,
        state,
        text,
        diagnostic,
        createdAt,
        remoteMessageIds,
        notification: true,
      }),
    );
  }
}
