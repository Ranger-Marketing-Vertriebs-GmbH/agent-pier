import { useRef } from "react";
import { browserUuid } from "../../lib/browser-uuid.js";

export default function useExplorerDrag(owner, onRequest) {
  const dragged = useRef(null);
  return {
    onDrag(items, event) {
      const token = browserUuid();
      dragged.current = { owner, items, token };
      event.dataTransfer.setData("application/x-agentpier-files", token);
      event.dataTransfer.effectAllowed = "move";
    },
    onDrop(target, event) {
      const value = dragged.current;
      if (
        !value ||
        value.owner !== owner ||
        event.dataTransfer.getData("application/x-agentpier-files") !== value.token
      )
        return;
      event.preventDefault();
      dragged.current = null;
      onRequest({ owner, kind: "move", items: value.items, target });
    },
  };
}
