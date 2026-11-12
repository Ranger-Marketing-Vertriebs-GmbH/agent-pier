import React, { useRef, useState } from "react";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import { placeAgent, positionOf, stepAgent } from "./agent-order.js";
import useAgentReorder from "./useAgentReorder.js";
import "./agent-order.css";

/**
 * The order the list shows: the saved `order` (agent ids), or the latest one being
 * saved, so a move does not jump back while its write and read run. `hold(ids)`
 * returns a token; `release(token)` shows the saved order again unless a later move
 * holds its own.
 */
export function useShownOrder(order) {
  const [pending, setPending] = useState(null);
  const last = useRef(0);
  return {
    order: pending?.ids ?? order,
    hold: (ids) => {
      const token = ++last.current;
      setPending({ ids, token });
      return token;
    },
    release: (token) =>
      setPending((current) => (current?.token === token ? null : current)),
  };
}

/**
 * Reordering one person's agent list by drag and drop (useAgentReorder.js) and by
 * the rows' Move up / Move down. `display` lists the shown entries `{ id, section,
 * kind, name }` in order (agent-order.js); `save(ids)` stores the new order and reads
 * the list again, `regroup(id, from, to)` moves an agent into another section first
 * (the owner's groups). `shown` is the useShownOrder of the list. Moves show at once
 * and are saved one after another, so a quick second move is never lost. Each move
 * is announced; `status` renders that announcement.
 */
export default function useAgentOrdering({ display, shown, save, regroup, enabled }) {
  const queue = useRef(Promise.resolve());
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  const apply = (id, ids, section) => {
    const entry = display.find((other) => other.id === id);
    const byId = new Map(display.map((other) => [other.id, other]));
    const next = ids.map((other) =>
      other === id ? { ...entry, section } : byId.get(other),
    );
    const token = shown.hold(ids);
    setError("");
    queue.current = queue.current.then(async () => {
      try {
        if (section !== entry.section) await regroup(id, entry.section, section);
        await save(ids);
        const { position, count } = positionOf(next, id);
        setAnnouncement((last) => ({
          text: copy.moved(entry.name, position, count),
          count: last.count + 1,
        }));
      } catch (failure) {
        setError(failure.message);
      } finally {
        shown.release(token);
      }
    });
  };
  const reorder = useAgentReorder({
    enabled,
    entries: display,
    onDrop: (id, target) => {
      const ids = placeAgent(display, id, target);
      if (ids) apply(id, ids, target.section);
    },
  });
  const step = (id, direction) => {
    const ids = stepAgent(display, id, direction);
    const entry = display.find((other) => other.id === id);
    return ids ? () => apply(id, ids, entry.section) : null;
  };
  return {
    ...reorder,
    error,
    // The Move up / Move down actions of a row; null at the end it cannot pass.
    up: (id) => (enabled ? step(id, "up") : null),
    down: (id) => (enabled ? step(id, "down") : null),
    status: (
      <p className="visually-hidden" role="status">
        {announcement.text}
        {announcement.count % 2 ? " " : ""}
      </p>
    ),
  };
}

/** The class names that draw a row during a drag: lifted, or a line before or after. */
export function orderRowClass(drag, id) {
  if (!drag) return "";
  return [
    drag.id === id ? "agent-order-dragging" : "",
    drag.target?.beforeId === id ? "agent-order-before" : "",
    drag.target?.afterId === id ? "agent-order-after" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The class name of a section that takes a drop without rows to draw a line at. */
export const orderSectionClass = (drag, key) =>
  drag?.target?.section === key && !drag.target.beforeId && !drag.target.afterId
    ? "agent-order-target"
    : "";
