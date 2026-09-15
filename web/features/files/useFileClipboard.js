import { useEffect, useRef, useState } from "react";
import { browserUuid } from "../../lib/browser-uuid.js";

export function retainedClipboard(items, rows) {
  const removed = new Set(
    rows.filter((row) => row.sourceRemoved === true).map((row) => row.source),
  );
  return items.filter((item) => !removed.has(item.path));
}
export default function useFileClipboard(owner) {
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [stored, set] = useState(null);
  const current = stored?.owner === owner ? stored : null;
  const capture = (action, items) => {
    const token = {
      owner,
      generation: browserUuid(),
      action,
      items: items.map(({ path, revision }) => ({ path, revision })),
      jobs: [],
    };
    set(token);
    return token;
  };
  const clearCompleted = (token, rows) => {
    if (currentOwner.current !== token?.owner) return;
    set((prior) =>
      prior?.generation === token.generation && prior.action === "cut"
        ? { ...prior, items: retainedClipboard(prior.items, rows) }
        : prior,
    );
  };
  return {
    items: current?.items || [],
    action: current?.action || null,
    token: current,
    copy: (items) => capture("copy", items),
    cut: (items) => capture("cut", items),
    clearCompleted,
    track: (token, jobId) =>
      set((prior) =>
        prior?.generation === token?.generation
          ? { ...prior, jobs: [...prior.jobs, jobId] }
          : prior,
      ),
  };
}

// This is owned by the explorer, so navigation within a scope does not abandon Cut results.
export function useClipboardResults(clipboard, entries) {
  const token = clipboard.token;
  const rows = token?.jobs.flatMap((id) => entries[id]?.entries || []) || [];
  const proven = rows
    .filter((row) => row.sourceRemoved === true)
    .map((row) => row.source)
    .sort()
    .join("\0");
  useEffect(() => {
    if (token && proven) clipboard.clearCompleted(token, rows);
    // Stable proof changes, not polling/render frequency, trigger clipboard updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.generation, proven]);
}
