import { useCallback, useState } from "react";
import { PROJECT_VIEWS } from "./project-groups.js";

const viewKey = "agentpier.projects.view";
const collapsedKey = "agentpier.projects.collapsed";

// Storage can be missing or refuse access (private windows, blocked site data); the
// list then starts from its defaults and forgets changes on reload.
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function readCollapsed() {
  try {
    const saved = JSON.parse(read(collapsedKey) || "[]");
    return new Set(
      Array.isArray(saved) ? saved.filter((k) => typeof k === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Per-browser state of the projects list: the chosen view and the collapsed sections,
 * remembered per view and section (`<view>:<section key>`).
 */
export default function useProjectListPrefs() {
  const [view, setViewState] = useState(() => {
    const saved = read(viewKey);
    return PROJECT_VIEWS.includes(saved) ? saved : "groups";
  });
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const setView = useCallback((next) => {
    setViewState(next);
    write(viewKey, next);
  }, []);
  const isCollapsed = useCallback(
    (sectionKey) => collapsed.has(`${view}:${sectionKey}`),
    [collapsed, view],
  );
  const toggleSection = useCallback(
    (sectionKey) =>
      setCollapsed((current) => {
        const key = `${view}:${sectionKey}`;
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        write(collapsedKey, JSON.stringify([...next]));
        return next;
      }),
    [view],
  );
  return { view, setView, isCollapsed, toggleSection };
}
