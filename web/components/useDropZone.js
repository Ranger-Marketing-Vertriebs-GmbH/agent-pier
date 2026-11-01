import { useState } from "react";
import { sideAt } from "./split-geometry.js";

/**
 * The drop side for a drag over a rect, or null when the drag is not ours or the side
 * is not allowed. Pure so the decision is testable without a DOM.
 */
export function dropDecision({ types, accepts, allowed, rect, x, y }) {
  if (!accepts(Array.from(types ?? []))) return null;
  const side = sideAt(rect, x, y);
  return !allowed || allowed(side) ? side : null;
}

/**
 * Drop zones on a pane edge or centre. Drags that `accepts` rejects are left alone
 * (no preventDefault), so other drop handlers on the same element keep working.
 */
export default function useDropZone({ accepts, allowed, onDrop }) {
  const [side, setSide] = useState(null);

  const decide = (event) => {
    const types = event.dataTransfer?.types;
    if (!accepts(Array.from(types ?? []))) return undefined;
    return dropDecision({
      types,
      accepts,
      allowed,
      rect: event.currentTarget.getBoundingClientRect(),
      x: event.clientX,
      y: event.clientY,
    });
  };

  const over = (event) => {
    const next = decide(event);
    if (next === undefined) return;
    if (next) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
    setSide(next);
  };

  return {
    side,
    handlers: {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setSide(null);
      },
      onDrop: (event) => {
        const next = decide(event);
        if (next === undefined) return;
        setSide(null);
        if (!next) return;
        event.preventDefault();
        onDrop(next, event.dataTransfer);
      },
    },
  };
}
