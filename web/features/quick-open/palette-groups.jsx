import React from "react";
import Icon from "../../components/Icon.jsx";
import { searchCopy as copy } from "../../lib/i18n/messages/search.js";

const icons = { pages: "arrow", actions: "plus" };

/** A result's icon: its own, an agent's initial (or emoji), or its group's. */
function resultIcon(item, text) {
  if (item.icon) return <Icon name={item.icon} size={14} />;
  if (item.mark) return Array.from(item.mark.trim())[0]?.toUpperCase() || "";
  if (item.group === "agents") return text(item.label).trim().charAt(0).toUpperCase();
  return <Icon name={icons[item.group] || "arrow"} size={14} />;
}

/** A result's second line: its path, what it is, and the old name it matched. */
function resultDetail(item, text) {
  return [
    text(item.path),
    text(item.meta),
    item.alias ? copy.formerly(text(item.alias)) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Search results (`searchEntries` groups) as `CommandPalette` groups in `language`;
 * each item keeps its index entry as `entry`.
 */
export function paletteGroups(found, language) {
  const text = (value) => value?.[language] ?? value?.de ?? "";
  return found.map((group) => ({
    id: group.group,
    label: copy.groups[group.group],
    items: group.items.map((item) => ({
      id: item.id,
      entry: item,
      label: text(item.label),
      detail: resultDetail(item, text),
      icon: resultIcon(item, text),
    })),
  }));
}

/** How many results the groups hold. */
export const resultCount = (groups) =>
  groups.reduce((sum, group) => sum + group.items.length, 0);
