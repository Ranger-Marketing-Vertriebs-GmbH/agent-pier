import { useCallback, useEffect, useState } from "react";

const key = (a) => `${a.id}:${a.revision}`;

/**
 * Actions the owner decided while the chat feed carries the list: the decided
 * revision stays hidden until the feed pushes the action's next state, so a card
 * never offers its buttons again in between. A new revision shows normally.
 */
export default function usePushedDecisions(scope) {
  const [decided, setDecided] = useState(() => new Set());
  useEffect(() => setDecided(new Set()), [scope]);
  const hidden = useCallback((a) => decided.has(key(a)), [decided]);
  const hide = useCallback(
    (a) => setDecided((current) => new Set(current).add(key(a))),
    [],
  );
  return { hidden, hide };
}
