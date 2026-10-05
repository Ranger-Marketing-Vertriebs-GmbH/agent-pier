import { JsonlHistoryReader } from "./jsonl-history-reader.js";
import { text } from "./observability-values.js";
import { setImmediate as yieldTurn } from "node:timers/promises";

const BLOCK = 64 * 1024;
const MAX_RECORD = 2 * 1024 * 1024;
const MAX_LIMITS = 16;
const MAX_THREADS = 8;
const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const usage = (value) =>
  value && typeof value === "object"
    ? Object.fromEntries(USAGE_FIELDS.map((field) => [field, count(value[field])]))
    : undefined;
const windowOf = (value) =>
  value && typeof value === "object"
    ? {
        used_percent: count(value.used_percent),
        window_minutes: count(value.window_minutes),
        resets_at: count(value.resets_at),
      }
    : null;
const creditsOf = (value) =>
  value && typeof value === "object"
    ? {
        has_credits: value.has_credits === true,
        unlimited: value.unlimited === true,
        balance: text(value.balance, 40) || null,
      }
    : null;
/** Bounded metadata cache. Read complete append-only records without retaining conversation bodies. */
export class CodexRolloutMetadata {
  constructor() {
    this.entries = new Map();
  }
  async read(history, session, thread) {
    if (
      !thread.path ||
      (await history.codexRolloutIdentity(session, thread.path)) !== thread.id
    )
      return [];
    const key = JSON.stringify([session.accountId, session.cwd, thread.id, thread.path]);
    let entry = this.entries.get(key);
    if (!entry) entry = { offset: 0, records: new Map(), plans: new Map(), agents: [] };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value);
    if (entry.pending) return entry.pending;
    entry.pending = this.scan(thread.path, entry).finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }
  async scan(file, entry) {
    if (entry.identity) {
      let previous;
      try {
        previous = await JsonlHistoryReader.open(file, entry.identity);
      } catch {
        entry.offset = 0;
        entry.records.clear();
        entry.sessionId = null;
        entry.plans.clear();
        entry.agents = [];
      } finally {
        await previous?.close();
      }
    }
    const reader = await JsonlHistoryReader.open(file);
    let pending = Buffer.alloc(0),
      skipping = false;
    try {
      for (let position = entry.offset; position < reader.identity.size;) {
        const bytes = await reader.bytes(
          position,
          Math.min(BLOCK, reader.identity.size - position),
        );
        position += bytes.length;
        pending = Buffer.concat([pending, bytes]);
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          if (!skipping && end <= MAX_RECORD) {
            try {
              this.update(entry, JSON.parse(pending.subarray(0, end).toString("utf8")));
            } catch {
              /* Partial or malformed native metadata is not authoritative. */
            }
          }
          skipping = false;
          pending = pending.subarray(end + 1);
          entry.offset = position - pending.length;
        }
        if (pending.length > MAX_RECORD) {
          pending = Buffer.alloc(0);
          skipping = true;
        }
        await yieldTurn();
      }
      await reader.validate();
      entry.identity = reader.identity;
      return [
        ...[...entry.records.values()].flat(),
        ...entry.agents,
        ...[...entry.plans.values()].flat(),
      ];
    } catch (error) {
      entry.identity = null;
      entry.offset = 0;
      entry.records.clear();
      entry.sessionId = null;
      entry.plans.clear();
      entry.agents = [];
      throw error;
    } finally {
      await reader.close();
    }
  }
  update(entry, record) {
    const p = record?.payload;
    if (record?.type === "turn_context")
      entry.records.set("model", {
        type: "turn_context",
        payload: { model: String(p?.model || "").slice(0, 200) },
      });
    if (
      record?.type === "compacted" ||
      (record?.type === "event_msg" &&
        (p?.type === "context_compacted" || (p?.type === "token_count" && p.info)))
    )
      entry.records.set("context", [
        ...(entry.records.has("model") ? [entry.records.get("model")] : []),
        {
          type: record.type,
          timestamp: record.timestamp,
          payload: {
            type: p?.type,
            ...(p?.info
              ? {
                  info: {
                    last_token_usage: {
                      total_tokens: p.info.last_token_usage?.total_tokens,
                    },
                    model_context_window: p.info.model_context_window,
                  },
                }
              : {}),
          },
        },
      ]);
    // The first session_meta is the rollout's own thread; forked and subagent
    // rollouts repeat their parent's session_meta after it.
    if (
      record?.type === "session_meta" &&
      typeof p?.id === "string" &&
      !entry.sessionId
    ) {
      entry.sessionId = p.id;
      for (const name of [...entry.records.keys()])
        if (name.startsWith("thread-usage:") && name !== `thread-usage:${p.id}`)
          entry.records.delete(name);
    }
    if (record?.type === "token_usage_record" && p?.thread_token_usage) {
      const id = typeof p.thread_id === "string" ? p.thread_id.slice(0, 120) : "";
      if (!entry.sessionId || !id || id === entry.sessionId) {
        const key = `thread-usage:${id}`;
        entry.records.delete(key);
        entry.records.set(key, {
          type: "token_usage_record",
          timestamp: record.timestamp,
          payload: {
            thread_id: id || undefined,
            thread_token_usage: usage(p.thread_token_usage),
          },
        });
        const keys = [...entry.records.keys()].filter((name) =>
          name.startsWith("thread-usage:"),
        );
        if (keys.length > MAX_THREADS) entry.records.delete(keys[0]);
      }
    }
    if (record?.type === "event_msg" && p?.type === "token_count") {
      if (p.info?.total_token_usage)
        entry.records.set("process-usage", {
          type: "event_msg",
          timestamp: record.timestamp,
          payload: {
            type: "token_count",
            info: { total_token_usage: usage(p.info.total_token_usage) },
          },
        });
      const limits = p.rate_limits;
      if (limits && typeof limits.limit_id === "string" && limits.limit_id) {
        const id = limits.limit_id.slice(0, 120);
        const key = `limits:${id}`;
        entry.records.delete(key);
        entry.records.set(key, {
          type: "event_msg",
          timestamp: record.timestamp,
          payload: {
            type: "token_count",
            rate_limits: {
              limit_id: id,
              limit_name: text(limits.limit_name, 120) || null,
              plan_type: text(limits.plan_type, 120) || null,
              primary: windowOf(limits.primary),
              secondary: windowOf(limits.secondary),
              credits: creditsOf(limits.credits),
            },
          },
        });
        const keys = [...entry.records.keys()].filter((name) =>
          name.startsWith("limits:"),
        );
        if (keys.length > MAX_LIMITS) entry.records.delete(keys[0]);
      }
    }
    if (JSON.stringify(record).length > 65536) return;
    if (
      record?.type === "event_msg" &&
      (p?.type?.startsWith("collab_") || p?.type === "sub_agent_activity")
    ) {
      entry.agents.push(record);
      if (entry.agents.length > 256) entry.agents.shift();
    }
    if (record?.type !== "response_item") return;
    const id = p?.call_id || p?.id;
    if (!id) return;
    if (
      ["function_call", "custom_tool_call"].includes(p.type) &&
      p.name === "update_plan"
    ) {
      entry.plans.set(id, [record]);
      while (entry.plans.size > 32) entry.plans.delete(entry.plans.keys().next().value);
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(p.type) &&
      entry.plans.has(id)
    )
      entry.plans.get(id).splice(1, 1, record);
  }
}
