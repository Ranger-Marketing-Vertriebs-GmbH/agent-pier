import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { assistantProblem } from "./assistant-validation.js";

/**
 * Between an update snapshot and its post-start check, AgentPier's ledgers are
 * fenced: reminder, team, channel and request writers are refused. Only work running
 * inside the update's validation scope may write; rows it inserts are recorded so the
 * check can exclude exactly those rows and still detect every other change.
 */
const fences = new Map();
const scope = new AsyncLocalStorage();
function state(root) {
  const key = path.resolve(root);
  if (!fences.has(key)) fences.set(key, { token: null, writes: [] });
  return fences.get(key);
}
export function ledgerFence(root) {
  const fence = state(root);
  return {
    // Each fence gets a fresh token. Timers, sockets and handlers created inside an
    // earlier validation keep that earlier token and are refused like any writer.
    close() {
      fence.token = {};
      fence.writes = [];
    },
    open() {
      fence.token = null;
      fence.writes = [];
    },
    validation: (operation) => scope.run(fence.token || {}, operation),
    writes: () => fence.writes.map((entry) => [...entry]),
  };
}
const fenced = () =>
  Object.assign(assistantProblem("unavailable", 503), {
    code: "ASSISTANT_LEDGER_FENCED",
  });
const mutation = /^\s*(?:WITH\b[\s\S]*?\b)?(INSERT|REPLACE|UPDATE|DELETE)\b/i;
const insertion = /^\s*(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+["`[]?([\w]+)/i;
function admit(fence, sql) {
  if (!fence.token || !mutation.test(sql)) return false;
  if (scope.getStore() !== fence.token) throw fenced();
  return true;
}
function wrapStatement(statement, sql, fence, ledger) {
  const table = insertion.exec(sql)?.[1];
  return new Proxy(statement, {
    get(target, property) {
      if (property === "run")
        return (...args) => {
          const recording = admit(fence, sql);
          const result = target.run(...args);
          if (recording && table && result.changes > 0)
            fence.writes.push([ledger, table, String(result.lastInsertRowid)]);
          return result;
        };
      if (["get", "all", "iterate"].includes(property))
        return (...args) => {
          admit(fence, sql);
          return target[property](...args);
        };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
/** Wraps an assistant ledger connection so the fence governs every write through it. */
export function fencedDatabase(database, root, ledger) {
  const fence = state(root);
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql, ...rest) =>
          wrapStatement(target.prepare(sql, ...rest), sql, fence, ledger);
      if (property === "exec")
        return (sql) => {
          admit(fence, sql);
          return target.exec(sql);
        };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
